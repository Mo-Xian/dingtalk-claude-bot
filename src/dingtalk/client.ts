import axios from 'axios';
import { DWClient, EventAck, type DWClientDownStream } from 'dingtalk-stream';
import type { DingTalkBot } from './bot.js';
import { logger } from '../logger.js';

interface StreamClientOptions {
  botToken: string;
  secret: string;
}

// AI 卡片模板 ID（从环境变量读取）
const CARD_TEMPLATE_ID = process.env.DINGTALK_CARD_TEMPLATE_ID || 'ed5262bd-f1d2-4def-ae1e-249c6cb5643a.schema';

export class DingTalkClient {
  private clientId: string;
  private clientSecret: string;
  private bot?: DingTalkBot;
  private dwClient?: DWClient;
  private cardInstances: Map<string, { outTrackId: string; guid: string }> = new Map(); // conversationId -> { outTrackId, guid }

  constructor(options: StreamClientOptions) {
    this.clientId = options.botToken;
    this.clientSecret = options.secret;
  }

  setBot(bot: DingTalkBot) {
    this.bot = bot;
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

    // Register callback listener for bot messages
    client.registerCallbackListener('/v1.0/im/bot/messages/get', (event: DWClientDownStream) => {
      this.handleCallback(event);
      // Return acknowledgment immediately to prevent retry
      return { status: EventAck.SUCCESS };
    });

    // Register for all other events
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

      // 同步检查重复 - 在返回 SUCCESS 之前就检查
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
      const senderNick = data.senderNick;
      const senderStaffId = data.senderStaffId;
      const chatbotUserId = data.chatbotUserId;
      const robotCode = data.robotCode;
      const sessionWebhook = data.sessionWebhook;

      logger.info('DingTalk-Client', '>>> Received message', {
        conversationId,
        senderNick,
        msgType,
        textPreview: text?.substring(0, 50),
        messageId,
        senderStaffId,
        chatbotUserId,
        robotCode,
      });

      if (msgType === 'text' && text) {
        // 异步处理消息，但不等待完成
        this.bot.handleMessage(
          conversationId,
          senderNick,
          text,
          msgUid,
          senderStaffId,
          sessionWebhook,
          robotCode
        ).catch((err) => {
          logger.error('DingTalk-Client', 'Handle message error', { error: err.message });
        });
      }
    } catch (error) {
      logger.error('DingTalk-Client', 'Error handling callback', { error });
    }
  }

  // 获取 access token
  private async getAccessToken(): Promise<string | null> {
    try {
      const response = await axios.get(
        'https://oapi.dingtalk.com/gettoken',
        { params: { appkey: this.clientId, appsecret: this.clientSecret } }
      );
      return response.data.access_token;
    } catch (error: any) {
      logger.error('DingTalk-Client', 'Failed to get access token', { error: error.message });
      return null;
    }
  }

  // 创建流式 AI 卡片
  async createStreamCard(conversationId: string, robotCode: string, senderStaffId: string, query: string = ''): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    const outTrackId = `claude_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const guid = `claude_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const spaceId = `dtv1.card//im_robot.${senderStaffId}`;

    logger.info('DingTalk-Client', 'Creating stream card', { outTrackId, guid, spaceId });

    try {
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
          imRobotOpenDeliverModel: {
            spaceType: 'IM_ROBOT',
            robotCode: robotCode
          },
          imRobotOpenSpaceModel: {
            supportForward: true
          },
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

      // 保存 outTrackId 和 guid
      this.cardInstances.set(conversationId, { outTrackId, guid });

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

    const { outTrackId, guid } = cardInfo;

    logger.info('DingTalk-Client', 'Streaming card update', {
      outTrackId,
      guid,
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
          isFull: isFinal,
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
}
