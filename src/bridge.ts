#!/usr/bin/env node
/**
 * claude-mux bridge
 *
 * MCP channel plugin that runs inside a Claude Code session.
 * Connects to the router via WebSocket and bridges messages
 * between Telegram (via router) and the Claude Code session.
 *
 * Agent name is auto-detected from git (repo/branch), or can be
 * overridden with the AGENT_NAME env var.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-mux-bridge
 *
 * Agent name is detected automatically:
 *   1. git remote repo name + current branch (e.g. "myapp/feature-nav")
 *   2. git repo root directory + branch (if no remote)
 *   3. current directory name (if not a git repo)
 *
 * Optional env vars:
 *   ROUTER_PORT   — port to connect to (default: 9900, shared with router)
 *   ROUTER_URL    — full WebSocket URL, overrides ROUTER_PORT (default: ws://127.0.0.1:{ROUTER_PORT}/ws)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execSync } from 'child_process'
import { WebSocket } from 'ws'

// ---------- git detection ----------

function detectAgentName(): string {
  try {
    // get the repo name from the remote origin, or fall back to directory name
    let repoName: string
    try {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim()
      // extract repo name from URLs like:
      //   git@github.com:user/repo.git
      //   https://github.com/user/repo.git
      repoName = remoteUrl.split('/').pop()?.replace(/\.git$/, '') ?? ''
    } catch {
      // no remote — use the repo root directory name
      const topLevel = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
      repoName = topLevel.split('/').pop() ?? ''
    }

    // get the current branch
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim()

    if (repoName && branch) {
      return `${repoName}/${branch}`
    }
    if (repoName) {
      return repoName
    }
  } catch {
    // not in a git repo
  }

  // last resort: use the current directory name
  const cwd = process.cwd()
  return cwd.split('/').pop() ?? 'unknown'
}

// ---------- config ----------

const AGENT_NAME = process.env.AGENT_NAME ?? detectAgentName()
console.error(`[bridge] Agent name: ${AGENT_NAME}`)

const ROUTER_PORT = process.env.ROUTER_PORT ?? '9900'
const ROUTER_URL = process.env.ROUTER_URL ?? `ws://127.0.0.1:${ROUTER_PORT}/ws`

// ---------- MCP server ----------

const mcp = new McpServer(
  { name: `claude-mux-bridge-${AGENT_NAME}`, version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      `Messages arrive as <channel source="claude-mux-bridge-${AGENT_NAME}" sender="..." chat_id="...">. `,
      'Reply using the "reply" tool, passing the chat_id from the tag. ',
      'When you finish a task, ALWAYS send a completion summary via the "notify" tool so the user gets a notification. ',
      `You are agent "${AGENT_NAME}". If asked who you are or which agent this is, identify yourself by this name.`,
    ].join(''),
  },
)

// ---------- tools ----------

mcp.registerTool('reply', {
  description: 'Reply to a message. Use this when responding to a user message that arrived via the channel.',
  inputSchema: {
    chat_id: z.string().describe('The chat_id from the inbound <channel> tag'),
    text: z.string().describe('The reply text to send'),
  },
}, async ({ text }) => {
  sendToRouter({ type: 'reply', text })
  return { content: [{ type: 'text' as const, text: 'sent' }] }
})

mcp.registerTool('notify', {
  description: 'Send a proactive notification to the user. Use this when a task completes, an error occurs, or you need to alert the user about something without them asking.',
  inputSchema: {
    text: z.string().describe('The notification text to send'),
  },
}, async ({ text }) => {
  sendToRouter({ type: 'notify', text })
  return { content: [{ type: 'text' as const, text: 'notification sent' }] }
})

// ---------- permission relay ----------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  sendToRouter({
    type: 'reply',
    text: [
      `Permission request:`,
      `Tool: ${params.tool_name}`,
      `Action: ${params.description}`,
      '',
      `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
    ].join('\n'),
  })
})

// ---------- WebSocket connection to router ----------

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_DELAY = 3000

// permission reply detection (same pattern as official plugins)
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function sendToRouter(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function connectToRouter() {
  try {
    ws = new WebSocket(ROUTER_URL)

    ws.onopen = () => {
      console.error(`[bridge:${AGENT_NAME}] Connected to router`)
      // register ourselves
      sendToRouter({ type: 'register', name: AGENT_NAME })
      // clear any reconnect timer
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>

        if (msg.type === 'registered') {
          console.error(`[bridge:${AGENT_NAME}] Registered with router as "${msg.name}"`)
        }

        if (msg.type === 'message') {
          const text = String(msg.text ?? '')
          const chatId = String(msg.chatId ?? '')
          const senderName = String(msg.senderName ?? 'user')

          // check for permission reply
          const m = PERMISSION_REPLY_RE.exec(text)
          if (m) {
            await mcp.server.notification({
              method: 'notifications/claude/channel/permission' as any,
              params: {
                request_id: m[2].toLowerCase(),
                behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
              },
            })
            return
          }

          // forward as channel notification to Claude
          await mcp.server.notification({
            method: 'notifications/claude/channel',
            params: {
              content: text,
              meta: {
                sender: senderName,
                chat_id: chatId,
              },
            },
          })
        }
      } catch (err) {
        console.error(`[bridge:${AGENT_NAME}] Error handling message:`, err)
      }
    }

    ws.onclose = () => {
      console.error(`[bridge:${AGENT_NAME}] Disconnected from router, reconnecting in ${RECONNECT_DELAY}ms...`)
      scheduleReconnect()
    }

    ws.onerror = (err) => {
      console.error(`[bridge:${AGENT_NAME}] WebSocket error:`, err)
    }
  } catch (err) {
    console.error(`[bridge:${AGENT_NAME}] Failed to connect:`, err)
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToRouter()
  }, RECONNECT_DELAY)
}

// ---------- startup ----------

// connect to Claude Code over stdio
await mcp.connect(new StdioServerTransport())

// connect to the router
connectToRouter()

// cleanup on exit
process.on('SIGINT', () => {
  ws?.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  ws?.close()
  process.exit(0)
})
