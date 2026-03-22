import type { DingTalkClient } from './client.js';
import type { ClaudeClient } from '../claude/client.js';
import { logger } from '../logger.js';

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

export class DingTalkBot {
  private dingtalk: DingTalkClient;
  private claude: ClaudeClient;
  private conversations: Map<string, Conversation> = new Map();
  private processingMessages: Map<string, number> = new Map(); // msgUid -> timestamp
  private initialized: boolean = false;

  constructor(dingtalk: DingTalkClient, claude: ClaudeClient) {
    this.dingtalk = dingtalk;
    this.claude = claude;
  }

  // 预初始化 Claude CLI，等待完成后才接收消息
  async preInitializeClaude(): Promise<boolean> {
    if (this.initialized) return true;

    logger.info('DingTalk-Bot', 'Pre-initializing Claude CLI...');

    // 使用固定的 'shared' sessionId 来预初始化
    // 这样所有后续请求都会复用这个进程
    const success = await this.claude.createSharedProcess();

    if (success) {
      this.initialized = true;
      logger.info('DingTalk-Bot', 'Claude CLI pre-initialization complete');
    } else {
      logger.error('DingTalk-Bot', 'Claude CLI pre-initialization failed');
    }

    return success;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async handleMessage(
    conversationId: string,
    senderNick: string,
    text: string,
    msgUid?: string,
    senderStaffId?: string,
    sessionWebhook?: string,
    robotCode?: string
  ) {
    logger.info('DingTalk-Bot', '=== New Message Received ===', {
      conversationId,
      senderNick,
      msgUid,
      senderStaffId,
      textLength: text.length,
      textPreview: text.substring(0, 100),
      conversationType: 'private',
    });

    // msgUid 已经在 handleCallback 中通过 shouldSkipMessage 添加

    try {
      let conversation = this.conversations.get(conversationId);
      if (!conversation) {
        logger.info('DingTalk-Bot', 'Creating new conversation', { conversationId });
        conversation = {
          id: conversationId,
          messages: [],
        };
        this.conversations.set(conversationId, conversation);
      } else {
        logger.debug('DingTalk-Bot', 'Existing conversation found', {
          conversationId,
          messageCount: conversation.messages.length,
        });
      }

      const userMessage: Message = {
        role: 'user',
        content: text,
        sender: senderNick,
        timestamp: Date.now(),
      };

      conversation!.messages.push(userMessage);
      logger.debug('DingTalk-Bot', 'User message added to conversation', {
        conversationId,
        totalMessages: conversation!.messages.length,
      });

      // 创建流式 AI 卡片 (每次消息都创建新卡片，因为旧卡片可能已被用户关闭)
      let outTrackId: string | undefined = undefined;
      if (senderStaffId && robotCode) {
        logger.info('DingTalk-Bot', 'Creating stream card', { conversationId, senderStaffId });
        const newOutTrackId = await this.dingtalk.createStreamCard(conversationId, robotCode, senderStaffId, text);
        if (newOutTrackId) {
          outTrackId = newOutTrackId;
          conversation!.outTrackId = newOutTrackId;
          logger.info('DingTalk-Bot', 'Stream card created', { conversationId, outTrackId });
        }
      }

      logger.info('DingTalk-Bot', '>>> Calling Claude Code', {
        conversationId,
        messageCount: conversation!.messages.length,
        latestMessage: text.substring(0, 100),
      });

      let fullResponse = '';
      let chunkCount = 0;
      let isComplete = false;

      logger.info('DingTalk-Bot', '>>> Claude Code streaming started', { conversationId });

      await this.claude.streamMessage({
        messages: conversation!.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        onChunk: async (chunk: string) => {
          if (isComplete) return;

          chunkCount++;
          fullResponse += chunk;

          logger.debug('DingTalk-Bot', '<<< Claude chunk', {
            conversationId,
            chunkNumber: chunkCount,
            chunkLength: chunk.length,
            totalResponseLength: fullResponse.length,
          });

          // 每次都更新，确保内容实时同步到钉钉
          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, fullResponse, false);
          }
        },
        onComplete: async () => {
          if (isComplete) return;
          isComplete = true;

          logger.info('DingTalk-Bot', '>>> Claude Code streaming completed', {
            conversationId,
            totalChunks: chunkCount,
            totalResponseLength: fullResponse.length,
            responsePreview: fullResponse.substring(0, 100),
          });

          conversation!.messages.push({
            role: 'assistant',
            content: fullResponse,
            timestamp: Date.now(),
          });

          logger.debug('DingTalk-Bot', 'Assistant response added to conversation', {
            conversationId,
            totalMessages: conversation!.messages.length,
          });

          // 更新卡片为完成状态
          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, fullResponse, true);
          }
        },
        onError: async (error: Error) => {
          logger.error('DingTalk-Bot', 'Claude Code streaming error', {
            conversationId,
            error: error.message,
          });

          const errorContent = `抱歉，发生了错误: ${error.message}`;
          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, errorContent, true);
          }
        },
      }, conversationId);
    } finally {
      // 不再删除 msgUid，基于时间去重
    }
  }

  clearConversation(conversationId: string) {
    logger.info('DingTalk-Bot', 'Clearing conversation', { conversationId });
    this.conversations.delete(conversationId);
  }

  isProcessing(msgUid: string): boolean {
    return this.processingMessages.has(msgUid);
  }

  addProcessing(msgUid: string): void {
    this.processingMessages.set(msgUid, Date.now());
  }

  // 同步检查是否应该跳过消息（先添加到map再检查）
  shouldSkipMessage(msgUid: string, createAt: number): boolean {
    if (!msgUid) return false;
    const now = Date.now();
    const last = this.processingMessages.get(msgUid);
    if (last && (now - last) < 120000) {
      return true; // 已经在处理中
    }
    // 先添加到 map，再返回 false（开始处理）
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
