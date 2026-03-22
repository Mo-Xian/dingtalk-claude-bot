# DingTalk Claude Bot

基于 Claude Code CLI 的钉钉机器人。通过钉钉流式 API 接收消息，并实时响应。

[English](./README_EN.md)

## 功能特性

- 通过钉钉互动卡片实时流式响应
- 会话内持久化对话历史
- WebSocket 连接钉钉流式 API
- 支持多并发对话

## 环境要求

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- 已启用流式 API 的钉钉机器人应用

## 快速开始

1. **克隆仓库**
   ```bash
   git clone <你的仓库地址>
   cd dingtalk-claude-bot
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 填入你的钉钉凭证：
   # DINGTALK_CLIENT_ID=你的_client_id
   # DINGTALK_CLIENT_SECRET=你的_client_secret
   ```

4. **构建项目**
   ```bash
   npm run build
   ```

5. **启动机器人**
   ```bash
   npm start
   ```

## 开发模式

```bash
npm run dev  # 使用 tsx watch 热重载
```

## 工作原理

1. 机器人通过 WebSocket 流式 API 连接钉钉
2. 用户向钉钉机器人发送消息
3. 机器人创建/复用持久化的 Claude Code CLI 进程
4. Claude Code 流式返回响应
5. 机器人实时更新钉钉互动卡片
6. 响应完成后卡片标记为结束

## 项目结构

```
src/
├── index.ts              # 入口点，服务器配置
├── config.ts             # 环境配置
├── logger.ts             # 结构化日志
├── claude/
│   └── client.ts        # Claude Code CLI 集成
└── dingtalk/
    ├── bot.ts           # 消息路由和会话状态
    ├── client.ts        # 钉钉 API 客户端
    └── card.ts          # 卡片消息模板
```

## 配置项

| 变量 | 描述 | 必填 |
|----------|-------------|----------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_CARD_TEMPLATE_ID` | 钉钉卡片模板 ID（默认：ed526bd...） | 否 |
| `PORT` | 服务器端口（默认：3000） | 否 |

## 钉钉卡片配置

机器人使用钉钉互动卡片模板进行消息展示，支持流式更新。

### 初始卡片模板

```typescript
{
  msgType: 'interactive',
  card: {
    header: {
      title: {
        tag: 'plainText',
        content: 'Claude AI Assistant',  // 可自定义
      },
      avatar: 'https://cdn-icons-png.flaticon.com/512/5693/5693025.png',
    },
    elements: [
      {
        tag: 'markdown',
        content: options.content,  // AI 回复内容
      },
    ],
  },
}
```

### 流式更新模板

```typescript
{
  card: {
    elements: [
      {
        tag: 'markdown',
        content: content,  // 增量更新的内容
      },
    ],
  },
}
```

### 自定义配置

修改 `src/dingtalk/card.ts` 中的以下内容：
- `header.title.content` - 卡片标题
- `header.avatar` - 卡片图标 URL
- `card.theme` - 卡片主题色

## 开源协议

MIT
