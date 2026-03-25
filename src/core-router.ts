/**
 * Core router for claude-mux.
 *
 * Manages agents via WebSocket, creates per-agent threads/channels
 * on one or more messaging platforms, and routes messages by thread.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { MessagingClient, ThreadCapableClient, InboundMessage } from './messaging-client.js'

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

export interface ClientEntry {
  /** Unique name for this client (e.g. "telegram", "discord") */
  name: string
  client: MessagingClient
  /** Chat/guild ID — where threads are created */
  chatId: string
}

// ---------- router ----------

export class Router {
  private readonly clients: ClientEntry[]
  private readonly port: number
  private readonly host: string
  private readonly topicsFile: string | null

  private readonly agents = new Map<string, Agent>()
  private readonly wsBySocket = new Map<WebSocket, Agent>()

  // per-client thread mappings: clientName → (agentName → threadId)
  private readonly agentThreads = new Map<string, Map<string, string>>()
  // reverse lookup: threadId → agentName (thread IDs are unique across platforms)
  private readonly threadToAgent = new Map<string, string>()

  constructor(opts: {
    clients: ClientEntry[]
    port?: number
    host?: string
    topicsFile?: string
  }) {
    this.clients = opts.clients
    this.port = opts.port ?? 9900
    this.host = opts.host ?? '127.0.0.1'
    this.topicsFile = opts.topicsFile ?? null

    // initialize per-client maps
    for (const entry of this.clients) {
      this.agentThreads.set(entry.name, new Map())
    }
  }

  // ---------- thread persistence ----------

  private loadOldTopics(): Record<string, Record<string, string>> {
    if (!this.topicsFile) return {}
    try {
      return JSON.parse(readFileSync(this.topicsFile, 'utf-8')) as Record<string, Record<string, string>>
    } catch {
      return {}
    }
  }

  private saveTopics(): void {
    if (!this.topicsFile) return
    try {
      const data: Record<string, Record<string, string>> = {}
      for (const [clientName, threads] of this.agentThreads) {
        if (threads.size > 0) {
          data[clientName] = Object.fromEntries(threads)
        }
      }
      writeFileSync(this.topicsFile, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      console.error('[router] Failed to save topic mappings:', err)
    }
  }

  /** Delete old threads/channels left over from a previous run. */
  private async cleanupOldTopics(): Promise<void> {
    const oldTopics = this.loadOldTopics()

    for (const entry of this.clients) {
      if (!('createThread' in entry.client)) continue
      const threadClient = entry.client as ThreadCapableClient
      const clientTopics = oldTopics[entry.name]
      if (!clientTopics) continue

      const entries = Object.entries(clientTopics)
      if (entries.length === 0) continue

      console.log(`[router] Cleaning up ${entries.length} old ${entry.name} thread(s)...`)
      for (const [name, threadId] of entries) {
        await threadClient.deleteThread(entry.chatId, threadId)
        console.log(`[router] Deleted ${entry.name} thread "${name}" (${threadId})`)
      }
    }

    // clear the file
    this.saveTopics()
  }

  async start(): Promise<void> {
    const clientNames = this.clients.map(e => e.name).join(', ')
    console.log(`[router] Connecting clients: ${clientNames}`)

    // connect all clients that support it (so they're ready for cleanup)
    for (const entry of this.clients) {
      if (entry.client.connect) {
        await entry.client.connect()
      }
    }

    // clean up threads from previous run (clients are now connected)
    await this.cleanupOldTopics()

    // wire up inbound messages from all clients
    for (const entry of this.clients) {
      entry.client.onMessage(this.handleInboundMessage.bind(this))
    }

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

    // start all messaging client event loops in parallel (may block)
    await Promise.all(this.clients.map(entry =>
      entry.client.start().catch(err => {
        console.error(`[router] ${entry.name} client error:`, err)
      })
    ))
  }

  // ---------- inbound message dispatch ----------

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    if (!msg.threadId) return

    const agentName = this.threadToAgent.get(msg.threadId)
    if (!agentName) {
      console.log(`[router] Message in unmapped thread ${msg.threadId}, ignoring`)
      return
    }

    const agent = this.agents.get(agentName)
    if (!agent) {
      // find which client this message came from to reply on the right one
      const entry = this.findClientForThread(msg.threadId)
      if (entry) {
        await entry.client.sendMessage(entry.chatId, `Agent "${agentName}" is not connected.`, msg.threadId)
      }
      return
    }

    console.log(`[router] Routing to ${agentName} via thread ${msg.threadId}`)
    agent.ws.send(JSON.stringify({
      type: 'message',
      text: msg.text,
      chatId: msg.chatId,
      threadId: msg.threadId,
      senderName: msg.senderName,
    }))
  }

  private findClientForThread(threadId: string): ClientEntry | undefined {
    for (const entry of this.clients) {
      const threads = this.agentThreads.get(entry.name)
      if (threads) {
        for (const tid of threads.values()) {
          if (tid === threadId) return entry
        }
      }
    }
    return undefined
  }

  // ---------- HTTP ----------

  private handleHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
    if (_req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const topicMappings: Record<string, Record<string, string>> = {}
      for (const [clientName, threads] of this.agentThreads) {
        if (threads.size > 0) {
          topicMappings[clientName] = Object.fromEntries(threads)
        }
      }
      res.end(JSON.stringify({
        agents: [...this.agents.keys()],
        clients: this.clients.map(e => e.name),
        topicMappings,
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

        // create threads on all clients
        this.createAgentThreads(name).then(() => {
          this.broadcastToAgent(name, `Agent connected.`)
        })

        ws.send(JSON.stringify({ type: 'registered', name }))
      }

      if (msg.type === 'reply' || msg.type === 'notify') {
        const agentInfo = this.wsBySocket.get(ws)
        if (!agentInfo) return
        this.broadcastToAgent(agentInfo.name, String(msg.text))
      }
    } catch (err) {
      console.error('[router] Bad message from bridge:', err)
    }
  }

  /** Send a message to all threads for an agent across all clients. */
  private async broadcastToAgent(agentName: string, text: string): Promise<void> {
    for (const entry of this.clients) {
      const threads = this.agentThreads.get(entry.name)
      const threadId = threads?.get(agentName)
      if (threadId) {
        await entry.client.sendMessage(entry.chatId, text, threadId)
      }
    }
  }

  /** Create threads for an agent on all clients. */
  private async createAgentThreads(agentName: string): Promise<void> {
    for (const entry of this.clients) {
      if (!('createThread' in entry.client)) continue
      const threadClient = entry.client as ThreadCapableClient

      const threadId = await threadClient.createThread(entry.chatId, agentName)
      if (threadId) {
        const threads = this.agentThreads.get(entry.name)!
        threads.set(agentName, threadId)
        this.threadToAgent.set(threadId, agentName)
        console.log(`[router] Created ${entry.name} thread ${threadId} for ${agentName}`)
      }
    }
    this.saveTopics()
  }

  private handleWsClose(ws: WebSocket): void {
    const agent = this.wsBySocket.get(ws)
    if (agent) {
      this.agents.delete(agent.name)
      this.wsBySocket.delete(ws)
      console.log(`[router] Agent disconnected: ${agent.name} (total: ${this.agents.size})`)
      this.broadcastToAgent(agent.name, `Agent disconnected.`)
    }
  }
}
