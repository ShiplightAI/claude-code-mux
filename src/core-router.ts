/**
 * Core router for claude-mux.
 *
 * Manages agents via WebSocket, creates Telegram forum topics per agent,
 * and routes messages by thread. Platform-agnostic — communicates
 * with users through a MessagingClient interface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { MessagingClient, ForumCapableClient, InboundMessage } from './messaging-client.js'

// ---------- types ----------

interface Agent {
  name: string
  ws: WebSocket
  registeredAt: Date
}

interface BridgeMessage {
  type: string
  [key: string]: unknown
}

// ---------- router ----------

export class Router {
  private readonly client: MessagingClient
  private readonly port: number
  private readonly host: string
  private readonly topicsFile: string | null

  private readonly agents = new Map<string, Agent>()
  private readonly wsBySocket = new Map<WebSocket, Agent>()
  private defaultChatId: string | null = null

  // each agent gets its own Telegram topic
  private readonly agentToThread = new Map<string, number>()   // agent name → thread_id
  private readonly threadToAgent = new Map<number, string>()   // thread_id → agent name

  constructor(opts: {
    client: MessagingClient
    port?: number
    host?: string
    forumChatId?: string
    topicsFile?: string
  }) {
    this.client = opts.client
    this.port = opts.port ?? 9900
    this.host = opts.host ?? '127.0.0.1'
    this.topicsFile = opts.topicsFile ?? null

    if (opts.forumChatId) {
      this.defaultChatId = opts.forumChatId
    }
  }

  // ---------- topic persistence ----------

  private loadOldTopics(): Record<string, number> {
    if (!this.topicsFile) return {}
    try {
      return JSON.parse(readFileSync(this.topicsFile, 'utf-8')) as Record<string, number>
    } catch {
      return {}
    }
  }

  private saveTopics(): void {
    if (!this.topicsFile) return
    try {
      writeFileSync(this.topicsFile, JSON.stringify(Object.fromEntries(this.agentToThread), null, 2) + '\n')
    } catch (err) {
      console.error('[router] Failed to save topic mappings:', err)
    }
  }

  /** Delete old topics from Telegram left over from a previous run. */
  private async cleanupOldTopics(): Promise<void> {
    if (!this.defaultChatId || !('deleteForumTopic' in this.client)) return
    const forumClient = this.client as ForumCapableClient
    const oldTopics = this.loadOldTopics()
    const entries = Object.entries(oldTopics)
    if (entries.length === 0) return

    console.log(`[router] Cleaning up ${entries.length} old topic(s) from previous run...`)
    for (const [name, threadId] of entries) {
      await forumClient.deleteForumTopic(this.defaultChatId, threadId)
      console.log(`[router] Deleted topic "${name}" (${threadId})`)
    }

    // clear the file
    this.saveTopics()
  }

  async start(): Promise<void> {
    // clean up topics from previous run before accepting connections
    await this.cleanupOldTopics()

    // wire up inbound messages from the client
    this.client.onMessage(this.handleInboundMessage.bind(this))

    // start HTTP + WebSocket server
    const httpServer = createServer(this.handleHttpRequest.bind(this))
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

    wss.on('connection', (ws: WebSocket) => {
      console.log('[router] Bridge connected')
      ws.on('message', (raw) => this.handleWsMessage(ws, String(raw)))
      ws.on('close', () => this.handleWsClose(ws))
    })

    httpServer.listen(this.port, this.host, () => {
      console.log(`[router] Listening on ws://${this.host}:${this.port}/ws`)
    })

    // start the messaging client (blocking — e.g. Telegram poll loop)
    await this.client.start()
  }

  // ---------- inbound message dispatch ----------

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    if (this.defaultChatId === null) {
      this.defaultChatId = msg.chatId
    }

    if (!msg.threadId) {
      // message in General topic or outside a thread — ignore
      return
    }

    const threadIdNum = parseInt(msg.threadId, 10)
    const agentName = this.threadToAgent.get(threadIdNum)

    if (!agentName) {
      console.log(`[router] Message in unmapped thread ${threadIdNum}, ignoring`)
      return
    }

    const agent = this.agents.get(agentName)
    if (!agent) {
      await this.client.sendMessage(msg.chatId, `Agent "${agentName}" is not connected.`, msg.threadId)
      return
    }

    console.log(`[router] Routing to ${agentName} via thread ${threadIdNum}`)
    agent.ws.send(JSON.stringify({
      type: 'message',
      text: msg.text,
      chatId: msg.chatId,
      threadId: msg.threadId,
      senderName: msg.senderName,
    }))
  }

  // ---------- HTTP ----------

  private handleHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
    if (_req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        agents: [...this.agents.keys()],
        paired: this.defaultChatId !== null,
        topicMappings: Object.fromEntries(this.agentToThread),
      }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('claude-mux router')
  }

  // ---------- WebSocket (bridges) ----------

  private handleWsMessage(ws: WebSocket, raw: string): void {
    try {
      const msg = JSON.parse(raw) as BridgeMessage

      if (msg.type === 'register') {
        const name = String(msg.name)
        if (this.agents.has(name)) {
          const old = this.agents.get(name)!
          this.wsBySocket.delete(old.ws)
          try { old.ws.close() } catch {}
        }
        const agent: Agent = { name, ws, registeredAt: new Date() }
        this.agents.set(name, agent)
        this.wsBySocket.set(ws, agent)
        console.log(`[router] Agent registered: ${name} (total: ${this.agents.size})`)

        if (this.defaultChatId) {
          this.createAgentTopic(name).then(threadId => {
            if (threadId) {
              this.client.sendMessage(this.defaultChatId!, `Agent connected.`, String(threadId))
            }
          })
        }

        ws.send(JSON.stringify({ type: 'registered', name }))
      }

      if (msg.type === 'reply' || msg.type === 'notify') {
        if (!this.defaultChatId) return
        const agentInfo = this.wsBySocket.get(ws)
        if (!agentInfo) return

        const threadId = this.agentToThread.get(agentInfo.name)
        if (threadId) {
          this.client.sendMessage(this.defaultChatId, String(msg.text), String(threadId))
        }
      }
    } catch (err) {
      console.error('[router] Bad message from bridge:', err)
    }
  }

  /** Create a forum topic for an agent. */
  private async createAgentTopic(agentName: string): Promise<number | null> {
    if (!this.defaultChatId || !('createForumTopic' in this.client)) return null
    const forumClient = this.client as ForumCapableClient

    const threadId = await forumClient.createForumTopic(this.defaultChatId, agentName)
    if (threadId) {
      this.agentToThread.set(agentName, threadId)
      this.threadToAgent.set(threadId, agentName)
      this.saveTopics()
      console.log(`[router] Created topic ${threadId} for ${agentName}`)
    }
    return threadId
  }

  private handleWsClose(ws: WebSocket): void {
    const agent = this.wsBySocket.get(ws)
    if (agent) {
      this.agents.delete(agent.name)
      this.wsBySocket.delete(ws)
      console.log(`[router] Agent disconnected: ${agent.name} (total: ${this.agents.size})`)

      // close the forum topic (keep the mapping so it can be reopened on reconnect)
      const threadId = this.agentToThread.get(agent.name)
      if (threadId && this.defaultChatId && 'closeForumTopic' in this.client) {
        const forumClient = this.client as ForumCapableClient
        forumClient.closeForumTopic(this.defaultChatId, threadId)
        this.client.sendMessage(this.defaultChatId, `Agent disconnected.`, String(threadId))
      }
    }
  }
}
