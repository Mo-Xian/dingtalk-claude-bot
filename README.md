# DingTalk Claude Bot

在钉钉中使用 Claude Code —— 像在终端一样，实时看到 Claude 读文件、执行命令、编辑代码的全过程。

[English](./README_EN.md)

## 效果预览

在钉钉中发送消息后，Claude 的每一步操作都会实时显示在互动卡片中：

```
---
📖 Read `.../src/index.ts`

     1→import express from 'express';
     2→const app = express();
     ...

---
⚡ Bash
  npm test

  ✓ 12 tests passed

---
✏️ Edit `.../src/index.ts`
  - const port = 3000;
  + const port = parseInt(process.env.PORT || "3000");

✅ The file src/index.ts has been updated successfully.

已将端口配置改为从环境变量读取，默认值仍为 3000。

---
⏱ 4 turns · 12.3s · $0.083
```

## 功能特性

- **完整操作可见** — 工具调用（Read、Bash、Edit、Write、Grep 等）实时展示在钉钉卡片中
- **流式响应** — 通过钉钉互动卡片实时更新，无需等待完整响应
- **多卡片分页** — 长任务输出自动拆分为多张卡片，内容不丢失
- **单聊 + 群聊** — 支持 1:1 私聊和群内 @机器人，自动适配卡片投递模型
- **多轮对话** — 基于固定 Session ID 保持上下文，Bot 重启后通过 `--resume` 自动续接
- **Proxy 架构** — Claude CLI 进程独立于 Bot，Bot 重启不影响 Claude CLI
- **图片支持** — 自动检测 Claude 工具产生的图片文件并发送到钉钉
- **消息去重** — 应对钉钉 At-Least-Once 投递语义
- **跨平台** — 支持 Windows（Git Bash）和 Linux/macOS

## 环境要求

- Node.js 18+
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- 已启用 Stream 模式的钉钉机器人应用

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Mo-Xian/dingtalk-claude-bot.git
cd dingtalk-claude-bot

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入钉钉凭证和 Claude 进程名

# 4. 开发模式启动
npm run dev

# 或者构建后启动
npm run build && npm start
```

## 架构

Bot 通过 Named Pipe 与独立的 Proxy 进程通信，Proxy 管理 Claude CLI 的生命周期。Bot 可以随意重启，不会影响正在运行的 Claude CLI。

```
                          Named Pipe
┌──────────┐  WebSocket  ┌──────┐ (\\.\pipe\...)  ┌───────┐  stdio   ┌──────────┐
│  钉钉用户 │ ←─────────→ │ Bot  │ ←────────────→ │ Proxy │ ←──────→ │  Claude  │
│          │  Stream API  │      │                │(长生命) │          │ Code CLI │
└──────────┘             └──┬───┘                └───────┘          └──────────┘
                            │                        ↑
                 updateCard()                   detached 进程
                            │                   Bot 重启后自动重连
                     ┌──────┴──────┐
                     │  钉钉卡片    │
                     │ (Markdown)   │
                     └─────────────┘
```

### 事件处理流程

Claude CLI 以 `stream-json` 格式输出事件，Proxy 透传到 Bot，Bot 逐个解析并格式化为 Markdown 推送到卡片：

| CLI 事件 | 卡片展示 |
|----------|---------|
| `assistant` → `tool_use` | 📖 **Read** / ⚡ **Bash** / ✏️ **Edit** + 参数 |
| `user` → `tool_result` | 工具执行结果（截断展示） |
| `assistant` → `text` | Claude 的文字回复 |
| `result` | ⏱ 统计（turns · 耗时 · 费用） |

### 项目结构

```
src/
├── index.ts              # 入口，组装组件、优雅关闭
├── config.ts             # 环境变量
├── logger.ts             # 结构化日志（console + 文件）
├── server/
│   └── express.ts        # Express 健康检查
├── claude/
│   ├── client.ts         # Proxy 连接管理、事件解析、格式化
│   └── proxy.ts          # 独立代理进程，管理 Claude CLI 生命周期
├── dingtalk/
│   ├── bot.ts            # 消息路由、会话管理、去重、多卡片分页
│   └── client.ts         # WebSocket 连接、卡片创建/更新、Token 缓存
└── mcp/
    └── dingtalk-image-server.ts  # MCP Tool：发送图片到钉钉
```

### 关键设计

**Proxy 架构** — Claude CLI 由独立的 Proxy 进程管理，通过 Named Pipe（Windows）/ Unix Socket 与 Bot 通信。Bot 启动时自动连接或创建 Proxy，Bot 关闭时只断开连接，不杀 Proxy 和 Claude CLI。

**进程名匹配** — 通过 `CLAUDE_PROCESS_NAME` 配置进程名，Bot 只连接匹配的 Proxy。不同的 Bot 实例可使用不同名称，互不干扰。

**自动重启** — Proxy 在 Claude CLI 崩溃后自动重启（指数退避，最多 5 次）。成功初始化后重置计数器。

**Session 恢复** — 首次启动用 `--session-id` 创建新会话；后续重启自动检测已有 session 文件并用 `--resume` 恢复，避免 "Session ID already in use" 冲突。

**进程树清理** — Windows 上退出时使用 `taskkill /T /F` 杀掉整个进程树（bash → claude.exe），防止孤儿进程残留。

**多卡片分页** — 当单张卡片内容超过阈值时，自动 finalize 当前卡片并创建新卡片继续输出，长任务内容不丢失。

**群聊支持** — 自动识别会话类型（单聊 `conversationType=1` / 群聊 `conversationType=2`），使用对应的卡片投递模型和 spaceId。群聊中 @机器人 即可触发。

**Token 缓存** — Access Token 缓存 2 小时（提前 5 分钟刷新），避免每次卡片更新都请求新 Token。

**会话历史上限** — 每个会话最多保留 50 条消息，防止内存无限增长。Claude CLI 通过 `--session-id` / `--resume` 自行维护完整上下文。

## 配置项

| 变量 | 描述 | 必填 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_CARD_TEMPLATE_ID` | 钉钉卡片模板 ID | 否 |
| `PORT` | 服务器端口（默认 3000） | 否 |
| `CLAUDE_PROCESS_NAME` | Claude CLI 进程名（默认 default） | 否 |

## Proxy 管理

Proxy 作为独立进程运行，文件位置：

| 文件 | Windows 路径 | 用途 |
|------|-------------|------|
| PID 文件 | `%TEMP%\claude-proxy-<name>.pid` | 记录 Proxy 进程 ID |
| 日志文件 | `%TEMP%\claude-proxy-<name>.log` | Proxy 运行日志 |
| Named Pipe | `\\.\pipe\claude-bot-<name>` | IPC 通信管道 |

```bash
# 查看 Proxy 日志
cat "$TEMP/claude-proxy-dingtalk-bot.log"

# 手动停止 Proxy（会同时停止 Claude CLI）
kill $(cat "$TEMP/claude-proxy-dingtalk-bot.pid")
```

## MCP 图片发送工具

项目提供了一个独立的 MCP Tool Server（`dingtalk_send_image`），让任何 Claude Code 实例都能直接发送图片到钉钉聊天。

### 注册

```bash
claude mcp add --global dingtalk-image -- node --import tsx /path/to/src/mcp/dingtalk-image-server.ts
```

### 环境变量

| 变量 | 描述 | 必填 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_ROBOT_CODE` | 钉钉机器人 Code | 是 |
| `DINGTALK_IMAGE_TARGET` | 默认发送目标，格式 `user:<staffId>` 或 `group:<conversationId>` | 否 |

### 使用方式

注册后，Claude Code 可直接调用：

```
请使用 dingtalk_send_image 工具把 ./output/chart.png 发送到钉钉
```

当从 Bot 触发时，Bot 会自动写入 `.dingtalk-context.json` 文件，MCP 工具读取该文件确定发送目标，无需手动指定 target。

## License

MIT
