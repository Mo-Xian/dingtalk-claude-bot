# DingTalk Claude Bot

A DingTalk bot powered by Claude Code CLI. Receives messages via DingTalk's streaming API and responds using Claude Code in real-time.

[中文](./README.md)

## Features

- Real-time streaming responses via DingTalk interactive cards
- Persistent conversation history within sessions
- WebSocket connection to DingTalk streaming API
- Support for multiple concurrent conversations

## Prerequisites

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A DingTalk bot application with streaming API enabled

## Quick Start

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd dingtalk-claude-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your DingTalk credentials:
   # DINGTALK_CLIENT_ID=your_client_id
   # DINGTALK_CLIENT_SECRET=your_client_secret
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Start the bot**
   ```bash
   npm start
   ```

## Development

```bash
npm run dev  # Run with hot-reload using tsx watch
```

## How It Works

1. Bot connects to DingTalk via WebSocket streaming API
2. User sends message to DingTalk bot
3. Bot creates/uses a persistent Claude Code CLI process
4. Claude Code streams response back
5. Bot updates DingTalk interactive card in real-time
6. Card marked as complete when response finishes

## Project Structure

```
src/
├── index.ts              # Entry point, server setup
├── config.ts             # Environment configuration
├── logger.ts             # Structured logging
├── claude/
│   └── client.ts        # Claude Code CLI integration
└── dingtalk/
    ├── bot.ts           # Message routing & conversation state
    ├── client.ts        # DingTalk API client
    └── card.ts          # Card message templates
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DINGTALK_CLIENT_ID` | DingTalk app client ID | Yes |
| `DINGTALK_CLIENT_SECRET` | DingTalk app client secret | Yes |
| `PORT` | Server port (default: 3000) | No |

## DingTalk Card Configuration

The bot uses DingTalk interactive cards for message display with streaming updates.

### Initial Card Template

```typescript
{
  msgType: 'interactive',
  card: {
    header: {
      title: {
        tag: 'plainText',
        content: 'Claude AI Assistant',  // customizable
      },
      avatar: 'https://cdn-icons-png.flaticon.com/512/5693/5693025.png',
    },
    elements: [
      {
        tag: 'markdown',
        content: options.content,  // AI response content
      },
    ],
  },
}
```

### Streaming Update Template

```typescript
{
  card: {
    elements: [
      {
        tag: 'markdown',
        content: content,  // incrementally updated content
      },
    ],
  },
}
```

### Customization

Modify the following in `src/dingtalk/card.ts`:
- `header.title.content` - Card title
- `header.avatar` - Card icon URL
- `card.theme` - Card theme color

## License

MIT
