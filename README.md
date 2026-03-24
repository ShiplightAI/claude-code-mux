# claude-code-mux

Talk to all your Claude Code agents from your phone. From a single mobile messaging app, chat with them in their active session, switch between agents, get notified when tasks finish, and approve permissions on the go. Seamlessly pick up where you left off — start a task on your desktop, continue the conversation from your phone.

Each agent gets its own Telegram topic — no switching commands needed. New agents auto-create topics; disconnected agents auto-close theirs (and reopen on reconnect).

## Install

```bash
npm install -g claude-code-mux
```

## Prerequisites

- Claude Code v2.1.80+
- Node.js 20+

## Quick Start

### 1. Create a Telegram Bot

Message **@BotFather** on Telegram → `/newbot` → pick a name and username → copy the **bot token** (looks like `123456789:ABCdef...`).

### 2. Create a Telegram group for your agents

This is the trickiest part — Telegram buries these settings, but you only do it once.

1. Open Telegram → **New Group** → add your bot → name it (e.g. "Claude Agents")
2. Open group settings → **Edit** → toggle **Topics** on
3. Group settings → **Administrators** → **Add Admin** → select your bot → enable **Manage Topics**
4. Open the **#General** topic and send any message (so the bot can auto-detect the group)

### 3. Start the router

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

Start the router:

```bash
claude-mux-router
```

Or without global install: `npx claude-mux-router`

On first run, the router auto-detects your forum group and saves the chat ID to `.env` automatically.

### 4. Set up the bridge (once)

Register the bridge as a global MCP server so every Claude Code session picks it up:

```bash
claude mcp add -s user claude-mux-bridge -- npx claude-mux-bridge
```

Then add `autoApprove` in `~/.claude.json` so the agent can reply without permission prompts:

```json
{
  "mcpServers": {
    "claude-mux-bridge": {
      "command": "npx",
      "args": ["claude-mux-bridge"],
      "autoApprove": ["reply", "notify"]
    }
  }
}
```

### 5. Launch Claude Code sessions

Just `cd` into any worktree and start Claude Code:

```bash
cd ~/projects/myapp-feature-nav
claude --dangerously-load-development-channels server:claude-mux-bridge
```

The agent registers with the router, which creates a Telegram topic for it automatically. Open the topic to chat with that agent. Spin up more sessions — each gets its own topic.

## Architecture

```
Telegram Forum Group
    |  (one topic per agent)
    v
Router (standalone process, localhost:9900)
  - Creates/closes topics as agents connect/disconnect
  - Routes messages by thread
    |  (WebSocket)
    v
Bridge (MCP channel plugin, one per Claude Code session)
  - Pushes messages into Claude Code session
  - Sends replies + notifications back through router
```

## Configuration

### Router

Set in `.env` (or as environment variables):

| Env var | Default | Description |
|---------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | auto-detect | Forum group chat ID — auto-detected, or set manually |
| `ROUTER_PORT` | `9900` | Port the router listens on |
| `ROUTER_HOST` | `127.0.0.1` | Bind address — use `0.0.0.0` for remote bridges |
| `ALLOWED_USER_IDS` | auto-pair | Comma-separated Telegram user IDs |

### Bridge

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENT_NAME` | auto-detect | Override agent name (default: git repo/branch) |
| `ROUTER_PORT` | `9900` | Must match the router's port |
| `ROUTER_URL` | `ws://127.0.0.1:{ROUTER_PORT}/ws` | Full WebSocket URL for remote routers |

## Troubleshooting

**"Conflict: terminated by other getUpdates request"**
Only one process can poll a Telegram bot token at a time. If you have the official `telegram@claude-plugins-official` plugin, uninstall it: `/plugin uninstall telegram@claude-plugins-official` inside Claude Code.

**"no MCP server configured with that name"**
Re-register with user scope: `claude mcp add -s user claude-mux-bridge -- npx claude-mux-bridge`

**Bridge tools keep asking for permission**
Add `autoApprove` to `~/.claude.json`: `"autoApprove": ["reply", "notify"]`

**Agent name shows as directory name instead of repo/branch**
Make sure you `cd` into a git repo before starting Claude Code.

**Switched to a new Telegram group?**
Delete `TELEGRAM_CHAT_ID` from `.env` and restart the router — it will auto-detect the new group.
