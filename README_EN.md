# DingTalk Claude Bot

Use Claude Code in DingTalk — watch Claude read files, run commands, and edit code in real-time, just like in the terminal.

[中文](./README.md)

## Preview

After sending a message in DingTalk, every step Claude takes is displayed in real-time via interactive cards:

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

Changed port configuration to read from environment variable, defaults to 3000.

---
⏱ 4 turns · 12.3s · $0.083
```

## Features

- **Full visibility** — Tool calls (Read, Bash, Edit, Write, Grep, etc.) displayed in real-time
- **Streaming responses** — DingTalk interactive cards update live, no waiting for full response
- **Multi-turn conversations** — Context maintained via Claude CLI `--session-id`
- **Concurrent users** — Shared Claude CLI process serves multiple conversations
- **Message deduplication** — Handles DingTalk's At-Least-Once delivery semantics
- **Cross-platform** — Supports Windows (Git Bash) and Linux/macOS

## Prerequisites

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A DingTalk bot application with Stream mode enabled

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Mo-Xian/dingtalk-claude-bot.git
cd dingtalk-claude-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your DingTalk credentials

# 4. Development mode
npm run dev

# Or build and start
npm run build && npm start
```

## Architecture

```
┌──────────┐   WebSocket    ┌──────────┐  stdin/stdout  ┌──────────┐
│ DingTalk │ ←───────────→ │ DingTalk │ ←────────────→ │  Claude  │
│   User   │  Stream API    │  Client  │  stream-json   │ Code CLI │
└──────────┘               └────┬─────┘               └──────────┘
                                │
                     updateCard() ← real-time per event
                                │
                         ┌──────┴─────┐
                         │  DingTalk  │
                         │   Card     │
                         └────────────┘
```

### Event Processing

Claude CLI outputs `stream-json` events. The bot parses each event and formats it as Markdown for the card:

| CLI Event | Card Display |
|-----------|-------------|
| `assistant` → `tool_use` | 📖 **Read** / ⚡ **Bash** / ✏️ **Edit** + params |
| `user` → `tool_result` | Tool execution result (truncated) |
| `assistant` → `text` | Claude's text response |
| `result` | ⏱ Stats (turns · duration · cost) |

### Project Structure

```
src/
├── index.ts              # Entry point, component wiring, graceful shutdown
├── config.ts             # Environment variables
├── logger.ts             # Structured logging (console + file)
├── server/
│   └── express.ts        # Express health check
├── claude/
│   └── client.ts         # Claude CLI process management, event parsing, formatting
└── dingtalk/
    ├── bot.ts            # Message routing, session management, deduplication
    └── client.ts         # WebSocket connection, card create/update, token cache
```

### Key Design Decisions

**Shared process** — A single Claude CLI subprocess is created on startup and shared across conversations. Falls back to per-conversation processes on session conflicts.

**Process lifecycle** — `.claude_sessions` file persists process info. Cleans up residual processes on startup; kills process trees and waits for exit on shutdown.

**Token caching** — Access token cached for 2 hours (refreshed 5 minutes early), preventing rate limits from per-update token requests.

**History cap** — Each conversation retains at most 50 messages to prevent unbounded memory growth. Claude CLI maintains full context via `--session-id`.

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DINGTALK_CLIENT_ID` | DingTalk app Client ID | Yes |
| `DINGTALK_CLIENT_SECRET` | DingTalk app Client Secret | Yes |
| `DINGTALK_CARD_TEMPLATE_ID` | DingTalk card template ID | No |
| `PORT` | Server port (default 3000) | No |

## License

MIT
