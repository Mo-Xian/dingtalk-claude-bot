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
- **多轮对话** — 基于 Claude CLI `--session-id` 保持上下文
- **并发支持** — 共享 Claude CLI 进程，多个用户可同时对话
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
# 编辑 .env 填入钉钉凭证

# 4. 开发模式启动
npm run dev

# 或者构建后启动
npm run build && npm start
```

## 架构

```
┌──────────┐   WebSocket    ┌──────────┐  stdin/stdout  ┌──────────┐
│  钉钉用户  │ ←───────────→ │ DingTalk │ ←────────────→ │  Claude  │
│          │  Stream API    │  Client  │  stream-json   │ Code CLI │
└──────────┘               └────┬─────┘               └──────────┘
                                │
                     updateCard() ← 每个事件实时更新
                                │
                         ┌──────┴─────┐
                         │  钉钉卡片   │
                         │ (Markdown)  │
                         └────────────┘
```

### 事件处理流程

Claude CLI 以 `stream-json` 格式输出事件，Bot 逐个解析并格式化为 Markdown 推送到卡片：

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
│   └── client.ts         # Claude CLI 进程管理、事件解析、格式化
└── dingtalk/
    ├── bot.ts            # 消息路由、会话管理、去重
    └── client.ts         # WebSocket 连接、卡片创建/更新、Token 缓存
```

### 关键设计

**共享进程** — 启动时创建一个共享 Claude CLI 子进程，所有对话复用。Session 冲突时自动回退到独立进程。

**进程生命周期** — `.claude_sessions` 文件持久化进程信息。启动时清理残留进程，关闭时杀进程树后等待退出。

**Token 缓存** — Access Token 缓存 2 小时（提前 5 分钟刷新），避免每次卡片更新都请求新 Token。

**会话历史上限** — 每个会话最多保留 50 条消息，防止内存无限增长。Claude CLI 通过 `--session-id` 自行维护完整上下文。

## 配置项

| 变量 | 描述 | 必填 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_CARD_TEMPLATE_ID` | 钉钉卡片模板 ID | 否 |
| `PORT` | 服务器端口（默认 3000） | 否 |

## License

MIT
