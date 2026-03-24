# claude-code-mux

Talk to all your Claude Code agents from your phone. From a single mobile messaging app, chat with them in their active session, switch between agents, get notified when tasks finish, and approve permissions on the go. Seamlessly pick up where you left off — start a task on your desktop, continue the conversation from your phone.

## Commands

| Command | Description |
|---------|-------------|
| `/list` | Show all connected agents |
| `/switch <agent>` | Switch to an agent by repo, branch, directory, or description |
| `/status` | Show which agent is active |
| `/help` | Show all commands |
| *(any message)* | Chat with the active agent, just like in the terminal |

## Usage (from Telegram)

```
You: /switch nav
Bot: Switched to myapp/feature-nav

You: switch to the one working on the bug fix
Bot: Switched to myapp/fix-auth-bug

You: can you add pagination to the /users endpoint?
Bot: [monots/encore] I'll add pagination to the /users endpoint...

Bot: [myapp/feature-nav] Finished refactoring the nav component.
     Changed 3 files, all 24 tests passing.
     Ready for your review.

Bot: [monots/encore] Permission request:
     Tool: Bash — Run npm test
     Reply "yes abcde" or "no abcde"
You: yes abcde
```

## Install

```bash
npm install -g claude-code-mux
```

## Prerequisites

- Claude Code v2.1.80+
- Node.js 20+
- A messaging platform bot token:
  - **Telegram** — supported now (see [Create a Telegram Bot](#create-a-telegram-bot) below)
  - **Discord** — coming soon
  - **WhatsApp** — coming soon
  - **Slack** — coming soon

## Create a Telegram Bot

1. Message **@BotFather** on Telegram → `/newbot` → pick a name and username
2. Copy the **bot token** (looks like `123456789:ABCdef...`)
3. Keep the token secret — never commit it to git

## Setup Router

The router is a standalone process that owns the Telegram bot and runs once on your machine (or a server). All agents connect to it.

### 1. Configure environment

Create a `.env` file (the router loads it automatically):

```env
# Required — your bot token from BotFather
TELEGRAM_BOT_TOKEN=123456789:ABCdef...

# Optional — enables LLM-powered natural language switching
# Pick a provider and set the corresponding API key:
ROUTER_MODEL=anthropic:claude-haiku-4-5-20251001
ANTHROPIC_API_KEY=sk-ant-...

# Or use OpenAI:
# ROUTER_MODEL=openai:gpt-5.4-nano
# OPENAI_API_KEY=sk-...

# Or Google:
# ROUTER_MODEL=google:gemini-3.1-flash-lite-preview
# GOOGLE_GENERATIVE_AI_API_KEY=...
```

See [Configuration > Router](#router) for all available options.

### 2. Start the router

```bash
claude-mux-router
```

Or without global install:

```bash
npx claude-mux-router
```

The router loads `.env` automatically and starts listening on `ws://127.0.0.1:9900/ws`.

### 3. Pair your Telegram account

Send any message to your bot in Telegram. The router auto-pairs with the first sender and remembers the chat ID for all future replies. If you set `ALLOWED_USER_IDS` in `.env`, only those users can interact with the bot.

## Setup Agent

Each Claude Code session needs the bridge MCP plugin to connect to the router. You register it once globally, then every agent picks it up automatically.

### 1. Register the bridge as a global MCP server

Use `claude mcp add` with the `-s user` flag so the bridge is available in **all** Claude Code sessions:

```bash
claude mcp add -s user claude-mux-bridge -- npx claude-mux-bridge
```

### 2. Enable autoApprove for bridge tools

Without this, you'd get a permission prompt every time the agent tries to reply or send a notification — which defeats the purpose of async communication. Open `~/.claude.json` and add `autoApprove` to the bridge entry:

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

### 3. Launch Claude Code sessions

Just `cd` into any worktree and start Claude Code. The agent name is auto-detected from git (repo/branch), or falls back to the directory name:

```bash
# Terminal 1 — auto-detects as "myapp/feature-nav"
cd ~/projects/myapp-feature-nav
claude --dangerously-load-development-channels server:claude-mux-bridge

# Terminal 2 — auto-detects as "monots/encore"
cd ~/worktrees/monots-encore
claude --dangerously-load-development-channels server:claude-mux-bridge

# Terminal 3 — auto-detects as "myapp/fix-auth-bug"
cd ~/projects/myapp-fix-auth-bug
claude --dangerously-load-development-channels server:claude-mux-bridge
```

No per-session env vars needed. Each session registers with the router automatically. When you spin up a new worktree, just start Claude Code in it — no extra setup required.

## Dynamic worktrees

The whole point of this tool: you don't create new bots or set env vars when you spin up a new worktree. Just start Claude Code in the directory:

```bash
cd ~/worktrees/myapp-hotfix-123
claude --dangerously-load-development-channels server:claude-mux-bridge
```

The bridge detects `myapp/hotfix-123` from git and registers automatically. When you close the session, it deregisters and your Telegram shows a disconnect notification.

## Architecture

```
Telegram Bot
    |
    v
Router (standalone process, localhost:9900)
  - Handles /list, /switch, /status commands
  - Routes messages to the active agent
    |  (WebSocket)
    v
Bridge (MCP channel plugin, one per Claude Code session)
  - Pushes messages into Claude Code session
  - Sends replies + notifications back through router
```

## Configuration

### Router

Set these in `.env` (or as environment variables) where you run `pnpm router`:

| Env var | Default | Description |
|---------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Bot token from BotFather |
| `ROUTER_MODEL` | (optional) | LLM for smart switching, format `provider:model-id` (e.g. `anthropic:claude-haiku-4-5-20251001`, `openai:gpt-5.4-nano`, `google:gemini-3.1-flash-lite-preview`) |
| `ANTHROPIC_API_KEY` | (optional) | API key for Anthropic models. If set without `ROUTER_MODEL`, defaults to `anthropic:claude-haiku-4-5-20251001` |
| `OPENAI_API_KEY` | (optional) | API key for OpenAI models |
| `GOOGLE_GENERATIVE_AI_API_KEY` | (optional) | API key for Google models |
| `ROUTER_PORT` | `9900` | Port the router listens on |
| `ROUTER_HOST` | `127.0.0.1` | Bind address — use `0.0.0.0` to allow remote bridge connections |
| `ALLOWED_USER_IDS` | auto-pair | Comma-separated Telegram user IDs |

### Bridge

The agent name is detected automatically: git repo + branch (e.g. `myapp/feature-nav`), or the current directory name if not in a git repo. Most bridge env vars are optional — the defaults work when router and bridge run on the same machine.

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENT_NAME` | auto-detect | Override the agent name (default: git repo/branch, or directory name) |
| `ROUTER_PORT` | `9900` | Must match the router's `ROUTER_PORT` |
| `ROUTER_URL` | `ws://127.0.0.1:{ROUTER_PORT}/ws` | Full WebSocket URL — set this when the router is on a different machine |

## Troubleshooting

**"Conflict: terminated by other getUpdates request"**
Only one process can poll a Telegram bot token at a time. If you installed the official `telegram@claude-plugins-official` plugin, uninstall it first: `/plugin uninstall telegram@claude-plugins-official` inside Claude Code.

**"no MCP server configured with that name"**
The bridge was likely registered to a project scope instead of user scope. Re-register with the `-s user` flag:
```bash
claude mcp add -s user claude-mux-bridge -- npx claude-mux-bridge
```

**Bridge tools keep asking for permission**
Add `autoApprove` to the MCP server config in `~/.claude.json`:
```json
"autoApprove": ["reply", "notify"]
```

**Agent name shows as the directory name instead of repo/branch**
The bridge couldn't detect git info. Make sure you `cd` into a git repo before starting Claude Code. If there's no git remote, it uses the repo root directory + branch. If it's not a git repo at all, it falls back to the current directory name.
