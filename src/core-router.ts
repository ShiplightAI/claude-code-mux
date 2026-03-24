/**
 * Core router for claude-mux.
 *
 * Handles agent management, command handling, fuzzy/LLM matching,
 * and the WebSocket server for bridges. Platform-agnostic — communicates
 * with users through a MessagingClient interface.
 */

import { generateText, generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { MessagingClient, InboundMessage } from './messaging-client.js'

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
  private readonly model: LanguageModel | null
  private readonly port: number
  private readonly host: string

  private readonly agents = new Map<string, Agent>()
  private readonly wsBySocket = new Map<WebSocket, Agent>()
  private activeAgent: string | null = null
  private defaultChatId: string | null = null

  constructor(opts: {
    client: MessagingClient
    model?: LanguageModel
    port?: number
    host?: string
  }) {
    this.client = opts.client
    this.model = opts.model ?? null
    this.port = opts.port ?? 9900
    this.host = opts.host ?? '127.0.0.1'

    if (this.model) {
      const modelId = typeof this.model === 'string' ? this.model : this.model.modelId
      console.log(`[router] LLM routing enabled (${modelId})`)
    } else {
      console.log('[router] LLM routing disabled (no model provided). Using fuzzy match only.')
    }
  }

  async start(): Promise<void> {
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
    // remember the chat for unsolicited messages (bridge replies, connect/disconnect)
    if (this.defaultChatId === null) {
      this.defaultChatId = msg.chatId
    }

    // handle commands — ALL /commands stay in the router, never forwarded
    if (msg.text.startsWith('/')) {
      const parsed = this.parseCommand(msg.text)
      console.log(`[router] Command detected: ${parsed ? `/${parsed.command} args="${parsed.args}"` : `(parse failed: "${msg.text}")`}`)
      await this.handleCommand(msg.chatId, msg.text)
      return
    }

    // natural language switch detection
    if (this.model && this.agents.size > 1 && /\bswitch\b/i.test(msg.text)) {
      console.log(`[router] "switch" keyword detected in: "${msg.text}", asking Haiku for intent...`)
      const intent = await this.detectSwitchIntent(msg.text)
      if (intent) {
        console.log(`[router] Haiku detected switch intent, query: "${intent.query}"`)
        await this.client.sendMessage(msg.chatId, await this.switchAgent(intent.query))
        return
      }
      console.log(`[router] Haiku says not a switch request, forwarding to agent`)
    }

    // route to active agent
    if (!this.activeAgent || !this.agents.has(this.activeAgent)) {
      if (this.agents.size === 1) {
        this.activeAgent = this.agents.keys().next().value ?? null
        console.log(`[router] Auto-selected only agent: ${this.activeAgent}`)
      } else {
        console.log(`[router] No active agent, ${this.agents.size} agents connected`)
        await this.client.sendMessage(msg.chatId, this.agents.size === 0
          ? 'No agents connected. Start a Claude Code session with the bridge plugin.'
          : `Multiple agents connected. Use /switch <name> to pick one.\n${this.listAgents()}`)
        return
      }
    }

    const agent = this.agents.get(this.activeAgent!)
    if (!agent) return

    console.log(`[router] Forwarding to agent: ${this.activeAgent}`)
    agent.ws.send(JSON.stringify({
      type: 'message',
      text: msg.text,
      chatId: msg.chatId,
      senderName: msg.senderName,
    }))
  }

  // ---------- LLM routing ----------

  private async llmMatchAgent(query: string, agentNames: string[]): Promise<string | 'NONE' | null> {
    if (!this.model || agentNames.length === 0) return null

    const prompt = `Agents:\n${agentNames.map(n => `- ${n}`).join('\n')}\n\nUser wants to switch to: "${query}"`
    console.log(`[llm] Request: ${prompt}`)

    try {
      const { text: result } = await generateText({
        model: this.model,
        maxOutputTokens: 100,
        system: [
          'You are a routing assistant. Given a list of agent names (formatted as repo/branch) and a user query, ',
          'pick the single best matching agent. Respond with ONLY the exact agent name, nothing else. ',
          'If no agent matches at all, respond with "NONE".',
        ].join(''),
        prompt,
      })

      const trimmed = result.trim()
      console.log(`[llm] Response: "${trimmed}"`)

      if (trimmed === 'NONE') return 'NONE'

      if (agentNames.includes(trimmed)) {
        console.log(`[llm] Exact match in agent list`)
        return trimmed
      }

      const lower = trimmed.toLowerCase()
      const found = agentNames.find(n => n.toLowerCase() === lower)
      if (found) {
        console.log(`[llm] Case-insensitive match: "${found}"`)
        return found
      }

      console.log(`[llm] Response "${trimmed}" does not match any agent: [${agentNames.join(', ')}]`)
      return null
    } catch (err) {
      console.error('[llm] LLM routing failed, falling back to fuzzy match:', err)
      return null
    }
  }

  private async detectSwitchIntent(text: string): Promise<{ query: string } | null> {
    if (!this.model) return null

    try {
      const { object: intent } = await generateObject({
        model: this.model,
        maxOutputTokens: 200,
        system: [
          'You help route messages. The user is chatting with coding agents identified by repo/branch names. ',
          'Determine if this message is asking to switch to a different agent/worktree/repo/branch. ',
          'If YES: set intent to "switch" and query to the part describing which agent. ',
          'If NO (the word "switch" is part of a coding instruction like "switch statement" or "switch branches in git"): ',
          'set intent to "message".',
        ].join(''),
        schema: z.object({
          intent: z.enum(['switch', 'message']),
          query: z.string().optional(),
        }),
        prompt: `Connected agents:\n${[...this.agents.keys()].map(n => `- ${n}`).join('\n')}\n\nUser message: "${text}"`,
      })

      console.log(`[llm-intent] Response: ${JSON.stringify(intent)}`)

      if (intent.intent === 'switch' && intent.query) {
        return { query: intent.query }
      }
      return null
    } catch (err) {
      console.error('[llm-intent] Intent detection failed, forwarding as message:', err)
      return null
    }
  }

  // ---------- command handling ----------

  private listAgents(): string {
    if (this.agents.size === 0) return 'No agents connected.'
    const lines: string[] = []
    for (const [name, agent] of this.agents) {
      const marker = name === this.activeAgent ? ' (active)' : ''
      const uptime = Math.round((Date.now() - agent.registeredAt.getTime()) / 60000)
      lines.push(`  ${name}${marker} — up ${uptime}m`)
    }
    return `Connected agents:\n${lines.join('\n')}`
  }

  private fuzzyMatchAgent(query: string): { name: string; score: number }[] {
    const queryTokens = query.toLowerCase().split(/[\s\/\-_]+/).filter(Boolean)
    if (queryTokens.length === 0) return []

    const results: { name: string; score: number }[] = []

    for (const agentName of this.agents.keys()) {
      const nameTokens = agentName.toLowerCase().split(/[\s\/\-_]+/).filter(Boolean)
      const nameLower = agentName.toLowerCase()

      let score = 0

      if (nameLower === query.toLowerCase()) {
        score = 1000
      } else {
        for (const qt of queryTokens) {
          if (nameTokens.includes(qt)) {
            score += 10
          } else if (nameTokens.some(nt => nt.startsWith(qt))) {
            score += 7
          } else if (nameLower.includes(qt)) {
            score += 4
          } else if (nameTokens.some(nt => qt.startsWith(nt))) {
            score += 2
          }
        }
      }

      if (score > 0) {
        results.push({ name: agentName, score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results
  }

  private async switchAgent(query: string): Promise<string> {
    console.log(`[switch] Query: "${query}"`)
    console.log(`[switch] Connected agents: [${[...this.agents.keys()].join(', ')}]`)

    if (this.agents.has(query)) {
      this.activeAgent = query
      console.log(`[switch] Exact match → ${query}`)
      return `Switched to ${query}`
    }

    const agentNames = [...this.agents.keys()]

    if (this.model) {
      console.log(`[switch] No exact match, calling LLM...`)
      const llmResult = await this.llmMatchAgent(query, agentNames)
      if (llmResult && llmResult !== 'NONE') {
        this.activeAgent = llmResult
        console.log(`[switch] Haiku matched → ${llmResult}`)
        return `Switched to ${llmResult}`
      }
      if (llmResult === 'NONE') {
        console.log(`[switch] Haiku says no match`)
        const available = agentNames.join('\n  ') || 'none'
        return `No agent matches "${query}". Connected:\n  ${available}`
      }
      console.log('[switch] Haiku unavailable, falling back to fuzzy match')
    }

    const matches = this.fuzzyMatchAgent(query)
    console.log(`[switch] Fuzzy matches: ${JSON.stringify(matches.slice(0, 5))}`)

    if (matches.length === 0) {
      console.log(`[switch] No fuzzy matches`)
      const available = agentNames.join('\n  ') || 'none'
      return `No agent matches "${query}". Connected:\n  ${available}`
    }

    if (matches.length === 1 || matches[0].score >= matches[1].score * 1.5) {
      this.activeAgent = matches[0].name
      console.log(`[switch] Fuzzy matched → ${matches[0].name} (score: ${matches[0].score})`)
      return `Switched to ${matches[0].name}`
    }

    console.log(`[switch] Ambiguous, showing options`)
    const options = matches.slice(0, 5)
      .map((m, i) => `  ${i + 1}. ${m.name}`)
      .join('\n')
    return `Multiple matches for "${query}":\n${options}\n\nBe more specific, or use /switch with the full name.`
  }

  private statusMessage(): string {
    const active = this.activeAgent && this.agents.has(this.activeAgent) ? this.activeAgent : 'none'
    return `Active: ${active}\nTotal agents: ${this.agents.size}`
  }

  private parseCommand(text: string): { command: string; args: string } | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return null

    // strip @bot_name suffix (Telegram convention, harmless for other platforms)
    const match = trimmed.match(/^\/(\w+)(?:@\S+)?\s*(.*)$/s)
    if (!match) return null

    return { command: match[1].toLowerCase(), args: match[2].trim() }
  }

  private async handleCommand(chatId: string, text: string): Promise<boolean> {
    const parsed = this.parseCommand(text)
    if (!parsed) return false

    switch (parsed.command) {
      case 'list':
        await this.client.sendMessage(chatId, this.listAgents())
        return true

      case 'status':
        await this.client.sendMessage(chatId, this.statusMessage())
        return true

      case 'switch':
        if (!parsed.args) {
          await this.client.sendMessage(chatId, 'Usage: /switch <agent-name>')
        } else {
          await this.client.sendMessage(chatId, await this.switchAgent(parsed.args))
        }
        return true

      case 'help':
      case 'start':
        await this.client.sendMessage(chatId, [
          'Commands:',
          '  /list — show connected agents',
          '  /switch <name> — route messages to an agent',
          '  /status — show current routing',
          '  /help — this message',
          '',
          'Any other message goes to the active agent.',
        ].join('\n'))
        return true

      default:
        await this.client.sendMessage(chatId, `Unknown command: /${parsed.command}\nType /help for available commands.`)
        return true
    }
  }

  // ---------- HTTP ----------

  private handleHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
    if (_req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        agents: [...this.agents.keys()],
        activeAgent: this.activeAgent,
        paired: this.defaultChatId !== null,
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

        if (this.agents.size === 1) this.activeAgent = name

        if (this.defaultChatId) {
          this.client.sendMessage(this.defaultChatId, `Agent "${name}" connected.${this.activeAgent === name ? ' (active)' : ` Use /switch ${name} to activate.`}`)
        }

        ws.send(JSON.stringify({ type: 'registered', name }))
      }

      if (msg.type === 'reply' || msg.type === 'notify') {
        if (!this.defaultChatId) return
        const agentInfo = this.wsBySocket.get(ws)
        const prefix = agentInfo ? `[${agentInfo.name}] ` : ''
        this.client.sendMessage(this.defaultChatId, `${prefix}${String(msg.text)}`)
      }
    } catch (err) {
      console.error('[router] Bad message from bridge:', err)
    }
  }

  private handleWsClose(ws: WebSocket): void {
    const agent = this.wsBySocket.get(ws)
    if (agent) {
      this.agents.delete(agent.name)
      this.wsBySocket.delete(ws)
      console.log(`[router] Agent disconnected: ${agent.name} (total: ${this.agents.size})`)
      if (this.activeAgent === agent.name) {
        this.activeAgent = this.agents.size > 0 ? this.agents.keys().next().value ?? null : null
      }
      if (this.defaultChatId) {
        this.client.sendMessage(this.defaultChatId, `Agent "${agent.name}" disconnected.${this.activeAgent ? ` Active: ${this.activeAgent}` : ''}`)
      }
    }
  }
}
