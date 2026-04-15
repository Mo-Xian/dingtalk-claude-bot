import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import FormData from 'form-data';
import { DWClient, EventAck, type DWClientDownStream } from 'dingtalk-stream';
import type { DingTalkBot } from './bot.js';
import { logger } from '../logger.js';

interface StreamClientOptions {
  botToken: string;
  secret: string;
}

// AI 卡片模板 ID（从环境变量读取）
const CARD_TEMPLATE_ID = process.env.DINGTALK_CARD_TEMPLATE_ID || 'ed5262bd-f1d2-4def-ae1e-249c6cb5643a.schema';

// Access Token 缓存
let cachedAccessToken: string | null = null;
let tokenExpiresAt: number = 0;

export class DingTalkClient {
  private clientId: string;
  private clientSecret: string;
  private bot?: DingTalkBot;
  private dwClient?: DWClient;
  private cardInstances: Map<string, { outTrackId: string; updateSeq: number }> = new Map();

  constructor(options: StreamClientOptions) {
    this.clientId = options.botToken;
    this.clientSecret = options.secret;
  }

  setBot(bot: DingTalkBot) {
    this.bot = bot;
  }

  close(): void {
    if (this.dwClient) {
      logger.info('DingTalk-Client', 'Closing DingTalk stream connection');
      try {
        // @ts-ignore - close 方法存在
        if (typeof this.dwClient.close === 'function') {
          // @ts-ignore
          this.dwClient.close();
        } else if (typeof this.dwClient.disconnect === 'function') {
          // @ts-ignore
          this.dwClient.disconnect();
        }
      } catch (e) {
        logger.error('DingTalk-Client', 'Error closing stream', { error: e });
      }
      this.dwClient = undefined;
    }
  }

  async startStream() {
    try {
      await this.connectStream();
    } catch (error) {
      logger.error('DingTalk-Client', 'Stream connection error, retrying in 5s', { error });
      setTimeout(() => this.startStream(), 5000);
    }
  }

  private async connectStream() {
    logger.info('DingTalk-Client', '========================================');
    logger.info('DingTalk-Client', 'Connecting to DingTalk stream...');
    logger.info('DingTalk-Client', 'clientId:', this.clientId);
    logger.info('DingTalk-Client', 'clientSecret length:', this.clientSecret.length);
    logger.info('DingTalk-Client', '========================================');

    const client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      debug: true,
    });

    client.registerCallbackListener('/v1.0/im/bot/messages/get', (event: DWClientDownStream) => {
      this.handleCallback(event);
      return { status: EventAck.SUCCESS };
    });

    client.registerAllEventListener((event: DWClientDownStream) => {
      logger.debug('DingTalk-Client', 'System event received', { type: event.type, topic: event.headers.topic });
      return { status: EventAck.SUCCESS };
    });

    client.on('connected', () => {
      logger.info('DingTalk-Client', '========================================');
      logger.info('DingTalk-Client', 'DingTalk stream CONNECTED successfully!');
      logger.info('DingTalk-Client', '========================================');
    });

    client.on('error', (error: Error) => {
      logger.error('DingTalk-Client', 'DingTalk stream ERROR:', { error: error.message, stack: error.stack });
    });

    client.on('disconnect', () => {
      logger.warn('DingTalk-Client', 'DingTalk stream DISCONNECTED');
    });

    this.dwClient = client;
    await client.connect();
  }

  private handleCallback(event: DWClientDownStream): void {
    if (!this.bot) return;

    const messageId = event.headers.messageId;
    const connectionId = event.headers.connectionId;

    try {
      const data = JSON.parse(event.data);

      const msgUid = data.msgId;
      const msgType = data.msgtype;
      const text = data.text?.content || data.text;
      const createAt = data.createAt;

      if (msgUid && this.bot.shouldSkipMessage(msgUid, createAt)) {
        logger.warn('DingTalk-Client', 'Duplicate message, skipping', { msgUid, createAt });
        return;
      }

      logger.debug('DingTalk-Client', 'Callback received', {
        messageId,
        connectionId,
        keys: Object.keys(data),
      });

      const conversationId = data.conversationId;
      const conversationType = data.conversationType; // "1" = 1:1, "2" = group
      const senderNick = data.senderNick;
      const senderStaffId = data.senderStaffId;
      const chatbotUserId = data.chatbotUserId;
      const robotCode = data.robotCode;
      const sessionWebhook = data.sessionWebhook;

      logger.info('DingTalk-Client', '>>> Received message', {
        conversationId,
        conversationType,
        senderNick,
        msgType,
        textPreview: text?.substring(0, 50),
        messageId,
        senderStaffId,
        chatbotUserId,
        robotCode,
      });

      if (msgType === 'text' && text) {
        this.bot.handleMessage(
          conversationId,
          senderNick,
          text,
          msgUid,
          senderStaffId,
          sessionWebhook,
          robotCode,
          conversationType
        ).catch((err) => {
          logger.error('DingTalk-Client', 'Handle message error', { error: err.message });
        });
      } else if (msgType === 'picture') {
        const downloadCode = data.content?.downloadCode;
        if (downloadCode && robotCode) {
          this.handleImageMessage(
            conversationId, senderNick, downloadCode, robotCode,
            msgUid, senderStaffId, sessionWebhook, conversationType
          ).catch((err) => {
            logger.error('DingTalk-Client', 'Handle image message error', { error: err.message });
          });
        } else {
          logger.warn('DingTalk-Client', 'Picture message missing downloadCode or robotCode', { downloadCode, robotCode });
        }
      } else if (msgType === 'richText') {
        const richTextParts = data.content?.richText;
        if (Array.isArray(richTextParts) && robotCode) {
          this.handleRichTextMessage(
            conversationId, senderNick, richTextParts, robotCode,
            msgUid, senderStaffId, sessionWebhook, conversationType
          ).catch((err) => {
            logger.error('DingTalk-Client', 'Handle richText message error', { error: err.message });
          });
        }
      }
    } catch (error) {
      logger.error('DingTalk-Client', 'Error handling callback', { error });
    }
  }

  // 获取 access token（带缓存，提前 5 分钟刷新）
  private async getAccessToken(): Promise<string | null> {
    const now = Date.now();
    if (cachedAccessToken && now < tokenExpiresAt) {
      return cachedAccessToken;
    }

    try {
      const response = await axios.get(
        'https://oapi.dingtalk.com/gettoken',
        { params: { appkey: this.clientId, appsecret: this.clientSecret } }
      );
      cachedAccessToken = response.data.access_token;
      // 钉钉 token 有效期 7200 秒，提前 5 分钟刷新
      const expiresIn = (response.data.expires_in || 7200) - 300;
      tokenExpiresAt = now + expiresIn * 1000;
      logger.info('DingTalk-Client', 'Access token refreshed', { expiresIn });
      return cachedAccessToken;
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to get access token', { error: error.message });
      return null;
    }
  }

  // 创建流式 AI 卡片（支持单聊和群聊）
  async createStreamCard(conversationId: string, robotCode: string, senderStaffId: string, query: string = '', conversationType: string = '1'): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    const outTrackId = `claude_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const isGroup = conversationType === '2';
    const spaceId = isGroup
      ? `dtv1.card//IM_GROUP.${conversationId}`
      : `dtv1.card//im_robot.${senderStaffId}`;

    logger.info('DingTalk-Client', 'Creating stream card', { outTrackId, spaceId, conversationType });

    try {
      // 根据会话类型构建不同的投递模型
      const deliverModel = isGroup
        ? {
            imGroupOpenDeliverModel: {
              robotCode: robotCode,
            },
            imGroupOpenSpaceModel: {
              supportForward: true,
            },
          }
        : {
            imRobotOpenDeliverModel: {
              spaceType: 'IM_ROBOT',
              robotCode: robotCode,
            },
            imRobotOpenSpaceModel: {
              supportForward: true,
            },
          };

      const response = await axios.post(
        'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver',
        {
          userId: senderStaffId,
          userIdType: 1,
          cardTemplateId: CARD_TEMPLATE_ID,
          outTrackId: outTrackId,
          callbackType: 'STREAM',
          openSpaceId: spaceId,
          robotCode: robotCode,
          ...deliverModel,
          cardData: {
            cardParamMap: {
              content: '# 正在思考...',
              flowStatus: '2',
            }
          }
        },
        {
          headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info('DingTalk-Client', 'Card created', { result: JSON.stringify(response.data).substring(0, 200) });

      this.cardInstances.set(conversationId, { outTrackId, updateSeq: 0 });

      return outTrackId;
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to create card', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      return null;
    }
  }

  // 更新 AI 卡片内容 - 使用流式更新接口
  async updateCard(conversationId: string, content: string, isFinal: boolean): Promise<void> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return;

    const cardInfo = this.cardInstances.get(conversationId);
    if (!cardInfo) {
      logger.warn('DingTalk-Client', 'No card instance found for conversation', { conversationId });
      return;
    }

    // 每次更新生成唯一 guid，钉钉会把相同 guid 的请求当重复请求忽略
    cardInfo.updateSeq++;
    const guid = `${cardInfo.outTrackId}_${cardInfo.updateSeq}`;
    const { outTrackId } = cardInfo;

    logger.info('DingTalk-Client', 'Streaming card update', {
      outTrackId,
      guid,
      seq: cardInfo.updateSeq,
      contentLength: content.length,
      isFinal,
    });

    try {
      const response = await axios.put(
        'https://api.dingtalk.com/v1.0/card/streaming',
        {
          outTrackId: outTrackId,
          guid: guid,
          key: 'content',
          content: content,
          isFull: true,
          isFinalize: isFinal,
          isError: false,
        },
        {
          headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      logger.info('DingTalk-Client', 'Card streaming update success', { status: response.status, data: JSON.stringify(response.data).substring(0, 200) });
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to update card', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
    }
  }

  // 发送文本消息（备用方法）
  async sendTextMessage(conversationId: string, text: string, sessionWebhook?: string): Promise<void> {
    if (!sessionWebhook) {
      logger.warn('DingTalk-Client', 'No sessionWebhook available');
      return;
    }

    try {
      const response = await axios.post(
        sessionWebhook,
        {
          msgType: 'text',
          text: { content: text },
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      logger.info('DingTalk-Client', 'Message sent', { status: response.status });
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to send message', {
        error: error.message,
        status: error.response?.status,
      });
    }
  }

  // 下载机器人接收到的图片文件（两步：获取 downloadUrl → 下载二进制）
  async downloadMessageImage(downloadCode: string, robotCode: string): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    try {
      // Step 1: 获取下载 URL
      const urlResponse = await axios.post(
        'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
        { downloadCode, robotCode },
        {
          headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json',
          },
        }
      );

      const downloadUrl = urlResponse.data?.downloadUrl;
      if (!downloadUrl) {
        logger.error('DingTalk-Client', 'No downloadUrl in response', { data: JSON.stringify(urlResponse.data).substring(0, 500) });
        return null;
      }

      logger.info('DingTalk-Client', 'Got image download URL', { downloadUrl: downloadUrl.substring(0, 100) });

      // Step 2: 下载图片二进制
      const imgResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      // 从 Content-Type 推断扩展名
      const contentType = imgResponse.headers['content-type'] || '';
      let ext = '.png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
      else if (contentType.includes('gif')) ext = '.gif';
      else if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('bmp')) ext = '.bmp';

      // 保存到临时文件
      const tmpDir = path.join(os.tmpdir(), 'dingtalk-images');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }

      const fileName = `img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(imgResponse.data));

      logger.info('DingTalk-Client', 'Image downloaded', { filePath, size: imgResponse.data.byteLength, contentType });
      return filePath;
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to download image', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data ? JSON.stringify(error.response.data).substring(0, 500) : undefined,
      });
      return null;
    }
  }

  // 处理图片消息
  private async handleImageMessage(
    conversationId: string, senderNick: string, downloadCode: string, robotCode: string,
    msgUid?: string, senderStaffId?: string, sessionWebhook?: string, conversationType?: string
  ): Promise<void> {
    if (!this.bot) return;

    logger.info('DingTalk-Client', 'Processing image message', { conversationId, senderNick });

    const filePath = await this.downloadMessageImage(downloadCode, robotCode);
    if (!filePath) {
      logger.error('DingTalk-Client', 'Failed to download image, skipping');
      return;
    }

    // 构造消息，让 Claude 自行决定用 Read 或 MCP 工具查看图片
    const normalizedPath = filePath.replace(/\\/g, '/');
    const text = `用户发送了一张图片，图片文件路径: ${normalizedPath}\n请读取这个图片文件并描述图片内容。`;
    this.bot.handleMessage(
      conversationId, senderNick, text,
      msgUid, senderStaffId, sessionWebhook, robotCode, conversationType
    ).catch((err) => {
      logger.error('DingTalk-Client', 'Handle image message error', { error: err.message });
    });
  }

  // 处理富文本消息（图文混合）
  private async handleRichTextMessage(
    conversationId: string, senderNick: string, richText: any[], robotCode: string,
    msgUid?: string, senderStaffId?: string, sessionWebhook?: string, conversationType?: string
  ): Promise<void> {
    if (!this.bot) return;

    logger.info('DingTalk-Client', 'Processing richText message', { conversationId, parts: richText.length });

    const textParts: string[] = [];
    const imagePaths: string[] = [];

    for (const part of richText) {
      if (part.text) {
        textParts.push(part.text);
      } else if (part.downloadCode && part.type === 'picture') {
        const filePath = await this.downloadMessageImage(part.downloadCode, robotCode);
        if (filePath) {
          imagePaths.push(filePath);
        }
      }
    }

    let text = textParts.join('');
    if (imagePaths.length > 0) {
      const imageInfo = imagePaths.map(p => `  - ${p}`).join('\n');
      text += `\n[用户同时发送了 ${imagePaths.length} 张图片，已保存到以下路径，请查看并分析：\n${imageInfo}]`;
    }

    if (!text.trim()) {
      logger.warn('DingTalk-Client', 'RichText message has no content after processing');
      return;
    }

    this.bot.handleMessage(
      conversationId, senderNick, text,
      msgUid, senderStaffId, sessionWebhook, robotCode, conversationType
    ).catch((err) => {
      logger.error('DingTalk-Client', 'Handle richText message error', { error: err.message });
    });
  }

  // 上传媒体文件到钉钉，返回 mediaId
  async uploadMedia(filePath: string, type: 'image' | 'voice' | 'video' | 'file' = 'image'): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    if (!fs.existsSync(filePath)) {
      logger.error('DingTalk-Client', 'File not found', { filePath });
      return null;
    }

    try {
      const form = new FormData();
      form.append('media', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
      });
      form.append('type', type);

      const response = await axios.post(
        `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}&type=${type}`,
        form,
        { headers: form.getHeaders() }
      );

      if (response.data.errcode === 0) {
        logger.info('DingTalk-Client', 'Media uploaded', { mediaId: response.data.media_id, type });
        return response.data.media_id;
      } else {
        logger.error('DingTalk-Client', 'Media upload failed', { error: response.data });
        return null;
      }
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to upload media', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      return null;
    }
  }

  // 通过 Robot API 发送图片消息（支持单聊和群聊）
  async sendImageToChat(
    filePath: string,
    robotCode: string,
    conversationType: string,
    conversationId: string,
    senderStaffId: string
  ): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return false;

    const mediaId = await this.uploadMedia(filePath, 'image');
    if (!mediaId) return false;

    return this.sendImageViaRobotApi(mediaId, robotCode, conversationType, conversationId, senderStaffId, accessToken);
  }

  // 通过 Robot API 发送图片
  private async sendImageViaRobotApi(
    mediaId: string,
    robotCode: string,
    conversationType: string,
    conversationId: string,
    senderStaffId: string,
    accessToken: string
  ): Promise<boolean> {
    try {
      const msgParam = JSON.stringify({ photoURL: mediaId });

      if (conversationType === '1') {
        // 单聊
        const response = await axios.post(
          'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
          {
            robotCode,
            userIds: [senderStaffId],
            msgKey: 'sampleImageMsg',
            msgParam,
          },
          {
            headers: {
              'x-acs-dingtalk-access-token': accessToken,
              'Content-Type': 'application/json',
            }
          }
        );
        logger.info('DingTalk-Client', 'Image sent via 1:1 robot API', { status: response.status, data: JSON.stringify(response.data).substring(0, 200) });
      } else {
        // 群聊
        const response = await axios.post(
          'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
          {
            robotCode,
            openConversationId: conversationId,
            msgKey: 'sampleImageMsg',
            msgParam,
          },
          {
            headers: {
              'x-acs-dingtalk-access-token': accessToken,
              'Content-Type': 'application/json',
            }
          }
        );
        logger.info('DingTalk-Client', 'Image sent via group robot API', { status: response.status, data: JSON.stringify(response.data).substring(0, 200) });
      }

      return true;
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to send image via robot API', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      });
      return false;
    }
  }
}
