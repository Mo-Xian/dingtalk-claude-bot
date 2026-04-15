import type { DingTalkClient } from './client.js';
import { ClaudeClient } from '../claude/client.js';
import { createHash } from 'crypto';
import { logger } from '../logger.js';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const MAX_HISTORY_MESSAGES = 50;
const DEDUP_CLEANUP_INTERVAL = 5 * 60 * 1000;
const DEDUP_TTL = 2 * 60 * 1000;

// 会话隔离配置
const MAX_CONCURRENT_CLIENTS = 10;          // 最大并发 Claude 实例
const CLIENT_IDLE_TIMEOUT = 30 * 60 * 1000; // 空闲 30 分钟后回收
const CLIENT_CLEANUP_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次

// 卡片更新配置
const CARD_UPDATE_INTERVAL = 500;    // 防抖间隔：500ms
const MAX_CARD_CONTENT = 8000;       // 单张卡片内容最大字符数
const CARD_SPLIT_THRESHOLD = 6000;   // 超过此长度时考虑分卡（留余量给截断提示）

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  messages: Message[];
  cardId?: string;
  outTrackId?: string;
}

interface ClientEntry {
  client: ClaudeClient;
  lastActivity: number;
}

export class DingTalkBot {
  private dingtalk: DingTalkClient;
  private baseProcessName: string;
  private claudeClients: Map<string, ClientEntry> = new Map();
  private conversations: Map<string, Conversation> = new Map();
  private processingMessages: Map<string, number> = new Map();
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;
  private clientCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(dingtalk: DingTalkClient, baseProcessName: string) {
    this.dingtalk = dingtalk;
    this.baseProcessName = baseProcessName;

    this.dedupCleanupTimer = setInterval(() => {
      this.cleanupProcessingMessages();
    }, DEDUP_CLEANUP_INTERVAL);

    this.clientCleanupTimer = setInterval(() => {
      this.cleanupIdleClients();
    }, CLIENT_CLEANUP_INTERVAL);
  }

  /**
   * 根据 conversationId 生成唯一的 processName
   */
  private getProcessName(conversationId: string): string {
    const hash = createHash('sha256').update(conversationId).digest('hex').substring(0, 8);
    return `${this.baseProcessName}-${hash}`;
  }

  /**
   * 获取或创建 per-conversation 的 ClaudeClient
   */
  private async getOrCreateClient(conversationId: string): Promise<ClaudeClient> {
    const entry = this.claudeClients.get(conversationId);
    if (entry) {
      entry.lastActivity = Date.now();
      if (entry.client.isConnected()) return entry.client;
      // 尝试重连
      const ok = await entry.client.connect();
      if (ok) return entry.client;
    }

    // 超过上限时淘汰最久未使用的
    if (this.claudeClients.size >= MAX_CONCURRENT_CLIENTS) {
      this.evictLruClient();
    }

    const processName = this.getProcessName(conversationId);
    const client = new ClaudeClient(processName);
    const ok = await client.connect();
    if (!ok) {
      throw new Error(`Failed to connect Claude proxy for conversation ${conversationId}`);
    }

    this.claudeClients.set(conversationId, { client, lastActivity: Date.now() });
    logger.info('DingTalk-Bot', 'Created new Claude client for conversation', {
      conversationId,
      processName,
      totalClients: this.claudeClients.size,
    });
    return client;
  }

  /**
   * 淘汰最久未使用的客户端
   */
  private evictLruClient(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, entry] of this.claudeClients) {
      if (entry.lastActivity < oldestTime) {
        oldestTime = entry.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId) {
      const entry = this.claudeClients.get(oldestId)!;
      entry.client.stopProxy();
      this.claudeClients.delete(oldestId);
      logger.info('DingTalk-Bot', 'Evicted LRU client', { conversationId: oldestId });
    }
  }

  /**
   * 清理空闲超时的客户端
   */
  private cleanupIdleClients(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.claudeClients) {
      if (now - entry.lastActivity > CLIENT_IDLE_TIMEOUT) {
        entry.client.stopProxy();
        this.claudeClients.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info('DingTalk-Bot', 'Cleaned up idle clients', { cleaned, remaining: this.claudeClients.size });
    }
  }

  private cleanupProcessingMessages(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [msgUid, timestamp] of this.processingMessages) {
      if (now - timestamp > DEDUP_TTL) {
        this.processingMessages.delete(msgUid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug('DingTalk-Bot', 'Cleaned up dedup entries', { cleaned, remaining: this.processingMessages.size });
    }
  }

  destroy(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
    }
    if (this.clientCleanupTimer) {
      clearInterval(this.clientCleanupTimer);
    }
    // 断开所有客户端（不杀 proxy，让它们自然存活以便 bot 重启后复用）
    for (const [, entry] of this.claudeClients) {
      entry.client.disconnect();
    }
    this.claudeClients.clear();
  }

  // 截断过长的卡片内容，保留开头提示和最新内容
  private truncateCardContent(content: string): string {
    if (content.length <= MAX_CARD_CONTENT) return content;

    const truncateNotice = '\n\n> ⚠️ *内容过长，已截断前部分*\n\n---\n\n';
    const keepEnd = MAX_CARD_CONTENT - truncateNotice.length;
    // 从后往前找一个换行符作为截断点，避免切断 markdown
    const tail = content.substring(content.length - keepEnd);
    const firstNewline = tail.indexOf('\n');
    const cleanTail = firstNewline > 0 ? tail.substring(firstNewline + 1) : tail;
    return truncateNotice + cleanTail;
  }

  async handleMessage(
    conversationId: string,
    senderNick: string,
    text: string,
    msgUid?: string,
    senderStaffId?: string,
    sessionWebhook?: string,
    robotCode?: string,
    conversationType?: string
  ) {
    logger.info('DingTalk-Bot', '=== New Message Received ===', {
      conversationId,
      senderNick,
      msgUid,
      senderStaffId,
      textLength: text.length,
      textPreview: text.substring(0, 100),
    });

    try {
      // /new 命令：重置 session，开启全新对话
      if (text.trim() === '/new') {
        await this.resetSession(conversationId, senderStaffId, robotCode, conversationType);
        return;
      }

      let conversation = this.conversations.get(conversationId);
      if (!conversation) {
        logger.info('DingTalk-Bot', 'Creating new conversation', { conversationId });
        conversation = {
          id: conversationId,
          messages: [],
        };
        this.conversations.set(conversationId, conversation);
      }

      const userMessage: Message = {
        role: 'user',
        content: text,
        sender: senderNick,
        timestamp: Date.now(),
      };

      conversation.messages.push(userMessage);

      if (conversation.messages.length > MAX_HISTORY_MESSAGES) {
        conversation.messages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
      }

      // 创建流式 AI 卡片
      let outTrackId: string | undefined = undefined;
      if (senderStaffId && robotCode) {
        logger.info('DingTalk-Bot', 'Creating stream card', { conversationId, senderStaffId });
        const newOutTrackId = await this.dingtalk.createStreamCard(conversationId, robotCode, senderStaffId, text, conversationType || '1');
        if (newOutTrackId) {
          outTrackId = newOutTrackId;
          conversation.outTrackId = newOutTrackId;
          logger.info('DingTalk-Bot', 'Stream card created', { conversationId, outTrackId });
        }
      }

      // Write context file for MCP tools (e.g. dingtalk_send_image)
      if (robotCode && senderStaffId) {
        try {
          const contextPath = path.join(process.cwd(), '.dingtalk-context.json');
          fs.writeFileSync(contextPath, JSON.stringify({
            conversationId,
            conversationType: conversationType || '1',
            senderStaffId,
            robotCode,
          }, null, 2));
        } catch (e: any) {
          logger.warn('DingTalk-Bot', 'Failed to write context file', { error: e.message });
        }
      }

      // 获取该会话专属的 Claude 客户端
      let claudeClient: ClaudeClient;
      try {
        claudeClient = await this.getOrCreateClient(conversationId);
      } catch (e: any) {
        logger.error('DingTalk-Bot', 'Failed to get Claude client', { conversationId, error: e.message });
        if (outTrackId) {
          await this.dingtalk.updateCard(conversationId, `❌ **Error**: ${e.message}`, true);
        }
        return;
      }

      logger.info('DingTalk-Bot', '>>> Calling Claude Code', {
        conversationId,
        latestMessage: text.substring(0, 100),
      });

      let fullResponse = '';
      let lastSentContent = '';   // 上次发送到卡片的内容
      let isComplete = false;
      let updateTimer: ReturnType<typeof setInterval> | null = null;
      let isUpdating = false;     // 防止并发更新

      // 多卡片支持：当内容超出单张卡片限制时，自动创建后续卡片
      let cardContentOffset = 0;  // 当前卡片对应 fullResponse 的起始位置
      let cardPartIndex = 0;      // 当前卡片编号（0-based）
      let isSplitting = false;    // 防止并发分卡

      // 获取当前卡片的内容
      const getCurrentCardContent = () => fullResponse.substring(cardContentOffset);

      // 分卡：finalize 当前卡片，创建新卡片
      const splitCard = async () => {
        if (isSplitting || !outTrackId || !robotCode || !senderStaffId) return;
        isSplitting = true;
        try {
          // Finalize 当前卡片（保留尾部内容 + 续接提示）
          const currentContent = getCurrentCardContent();
          const truncated = this.truncateCardContent(currentContent);
          const partLabel = cardPartIndex > 0 ? ` (Part ${cardPartIndex + 1})` : '';
          const finalContent = truncated + `\n\n---\n*↓ 内容继续到下一张卡片${partLabel}...*`;
          await this.dingtalk.updateCard(conversationId, finalContent, true);

          logger.info('DingTalk-Bot', 'Card split: finalized current card', {
            conversationId,
            part: cardPartIndex + 1,
            contentLength: currentContent.length,
          });

          // 创建新卡片
          cardPartIndex++;
          const newOutTrackId = await this.dingtalk.createStreamCard(
            conversationId, robotCode, senderStaffId,
            `(Part ${cardPartIndex + 1})`, conversationType || '1'
          );
          if (newOutTrackId) {
            outTrackId = newOutTrackId;
            conversation!.outTrackId = newOutTrackId;
            cardContentOffset = fullResponse.length; // 新卡片从当前位置开始
            lastSentContent = '';

            logger.info('DingTalk-Bot', 'Card split: new card created', {
              conversationId,
              part: cardPartIndex + 1,
              outTrackId: newOutTrackId,
            });
          }
        } catch (e: any) {
          logger.error('DingTalk-Bot', 'Card split failed', { error: e.message });
        } finally {
          isSplitting = false;
        }
      };

      // 防抖卡片更新：每 500ms 检查内容是否变化，变化则更新
      const startCardUpdater = () => {
        if (!outTrackId) return;
        updateTimer = setInterval(async () => {
          if (isUpdating || isComplete || isSplitting) return;

          // 检查是否需要分卡
          const cardContent = getCurrentCardContent();
          if (cardContent.length > CARD_SPLIT_THRESHOLD && robotCode && senderStaffId) {
            await splitCard();
            return;
          }

          const currentContent = this.truncateCardContent(cardContent);
          if (currentContent === lastSentContent) return;

          isUpdating = true;
          try {
            await this.dingtalk.updateCard(conversationId, currentContent, false);
            lastSentContent = currentContent;
            logger.debug('DingTalk-Bot', 'Card updated (debounced)', {
              conversationId,
              part: cardPartIndex + 1,
              contentLength: currentContent.length,
            });
          } catch (e: any) {
            logger.error('DingTalk-Bot', 'Card update failed', { error: e.message });
          } finally {
            isUpdating = false;
          }
        }, CARD_UPDATE_INTERVAL);
      };

      // 停止定时器并做最终更新
      const stopCardUpdater = async () => {
        if (updateTimer) {
          clearInterval(updateTimer);
          updateTimer = null;
        }
        // 等待进行中的更新/分卡完成
        while (isUpdating || isSplitting) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };

      startCardUpdater();

      await claudeClient.streamMessage({
        messages: [{ role: 'user', content: text }],
        onChunk: async (chunk: string) => {
          if (isComplete) return;
          // 只累积文本，不直接调 API（由定时器统一更新）
          fullResponse += chunk;
        },
        onImage: async (filePath: string) => {
          if (!robotCode || !senderStaffId) {
            logger.warn('DingTalk-Bot', 'Missing robotCode or senderStaffId, cannot send image', { filePath });
            return;
          }
          logger.info('DingTalk-Bot', 'Sending image to DingTalk', { conversationId, filePath, conversationType });
          const success = await this.dingtalk.sendImageToChat(
            filePath,
            robotCode,
            conversationType || '1',
            conversationId,
            senderStaffId
          );
          if (success) {
            logger.info('DingTalk-Bot', 'Image sent successfully', { conversationId, filePath });
          } else {
            logger.error('DingTalk-Bot', 'Failed to send image', { conversationId, filePath });
          }
        },
        onComplete: async () => {
          if (isComplete) return;
          isComplete = true;

          logger.info('DingTalk-Bot', '>>> Claude Code streaming completed', {
            conversationId,
            totalResponseLength: fullResponse.length,
            totalCards: cardPartIndex + 1,
            responsePreview: fullResponse.substring(0, 100),
          });

          conversation!.messages.push({
            role: 'assistant',
            content: fullResponse,
            timestamp: Date.now(),
          });

          if (conversation!.messages.length > MAX_HISTORY_MESSAGES) {
            conversation!.messages = conversation!.messages.slice(-MAX_HISTORY_MESSAGES);
          }

          // 停止定时器，做最终卡片更新
          await stopCardUpdater();
          if (outTrackId) {
            const finalCardContent = getCurrentCardContent();
            const finalContent = this.truncateCardContent(finalCardContent);
            try {
              await this.dingtalk.updateCard(conversationId, finalContent, true);
              logger.info('DingTalk-Bot', 'Card finalized', {
                conversationId,
                part: cardPartIndex + 1,
                contentLength: finalContent.length,
                totalResponseLength: fullResponse.length,
              });
            } catch (e: any) {
              logger.error('DingTalk-Bot', 'Card finalize failed', { error: e.message });
            }
          }
        },
        onError: async (error: Error) => {
          isComplete = true;
          await stopCardUpdater();

          logger.error('DingTalk-Bot', 'Claude Code streaming error', {
            conversationId,
            error: error.message,
          });

          if (outTrackId) {
            const cardContent = getCurrentCardContent();
            const errorContent = cardContent
              ? cardContent + `\n\n---\n\n❌ **Error**: ${error.message}`
              : `❌ **Error**: ${error.message}`;
            try {
              await this.dingtalk.updateCard(conversationId, this.truncateCardContent(errorContent), true);
            } catch (e: any) {
              logger.error('DingTalk-Bot', 'Error card update failed', { error: e.message });
            }
          }
        },
      }, conversationId);
    } finally {
      // 基于时间去重
    }
  }

  /**
   * /new 命令：停掉旧 proxy + 删除 session 文件 + 清内存，实现完全重置
   */
  private async resetSession(
    conversationId: string,
    senderStaffId?: string,
    robotCode?: string,
    conversationType?: string
  ): Promise<void> {
    const processName = this.getProcessName(conversationId);
    logger.info('DingTalk-Bot', '/new command: resetting session', { conversationId, processName });

    // 1. 停掉旧 proxy — 先尝试内存中的 client，再通过 PID 文件兜底
    const entry = this.claudeClients.get(conversationId);
    if (entry) {
      entry.client.stopProxy();
      this.claudeClients.delete(conversationId);
    } else {
      // bot 重启后内存无 client，直接通过 PID 文件杀 proxy
      this.killProxyByPidFile(processName);
    }

    // 2. 删除 session 文件，防止 --resume 恢复旧上下文
    const sessionId = createHash('sha256').update(processName).digest('hex');
    const formattedSessionId = `${sessionId.substring(0, 8)}-${sessionId.substring(8, 12)}-4${sessionId.substring(13, 16)}-${sessionId.substring(16, 20)}-${sessionId.substring(20, 32)}`;
    const cwd = process.cwd().replace(/[:\\/]/g, '-');
    const sessionDir = path.join(os.homedir(), '.claude', 'projects', cwd);

    // 删除 session 相关文件（.jsonl 和可能的其他文件）
    try {
      const sessionPrefix = formattedSessionId;
      if (fs.existsSync(sessionDir)) {
        for (const file of fs.readdirSync(sessionDir)) {
          if (file.startsWith(sessionPrefix)) {
            const fp = path.join(sessionDir, file);
            fs.unlinkSync(fp);
            logger.info('DingTalk-Bot', 'Session file deleted', { file: fp });
          }
        }
      }
    } catch (e: any) {
      logger.warn('DingTalk-Bot', 'Failed to delete session files', { error: e.message });
    }

    // 3. 清内存对话历史
    this.conversations.delete(conversationId);

    // 4. 回复确认
    if (senderStaffId && robotCode) {
      const outTrackId = await this.dingtalk.createStreamCard(
        conversationId, robotCode, senderStaffId, '/new', conversationType || '1'
      );
      if (outTrackId) {
        await this.dingtalk.updateCard(conversationId, '✅ 会话已重置，开始全新对话。', true);
      }
    }

    logger.info('DingTalk-Bot', 'Session reset complete', { conversationId });
  }

  /**
   * 通过 PID 文件杀掉 proxy 进程（用于 bot 重启后内存无 client 的情况）
   */
  private killProxyByPidFile(processName: string): void {
    const pidFile = path.join(os.tmpdir(), `claude-proxy-${processName}.pid`);
    try {
      if (!fs.existsSync(pidFile)) {
        logger.info('DingTalk-Bot', 'No PID file found, proxy may not be running', { pidFile });
        return;
      }
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
      if (isNaN(pid)) return;

      if (os.platform() === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      logger.info('DingTalk-Bot', 'Proxy killed via PID file', { processName, pid });
      fs.unlinkSync(pidFile);
    } catch (e: any) {
      logger.debug('DingTalk-Bot', 'killProxyByPidFile error (may already be stopped)', { error: e.message });
    }
  }

  clearConversation(conversationId: string) {
    logger.info('DingTalk-Bot', 'Clearing conversation', { conversationId });
    this.conversations.delete(conversationId);
  }

  shouldSkipMessage(msgUid: string, createAt: number): boolean {
    if (!msgUid) return false;
    const now = Date.now();
    const last = this.processingMessages.get(msgUid);
    if (last && (now - last) < DEDUP_TTL) {
      return true;
    }
    this.processingMessages.set(msgUid, now);
    return false;
  }

  getConversationStats(conversationId: string) {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    return {
      conversationId,
      messageCount: conv.messages.length,
      cardId: conv.outTrackId,
    };
  }
}
