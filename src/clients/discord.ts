/**
 * Discord messaging client for claude-mux router.
 *
 * Each agent gets a text channel under a "Claude Agents" category.
 * Channels are created when agents connect and deleted on cleanup.
 */

import { Client, Events, GatewayIntentBits, ChannelType, type TextChannel, type Guild, type CategoryChannel } from 'discord.js'
import type { ThreadCapableClient, OnMessageCallback } from '../messaging-client.js'

// ---------- client ----------

export class DiscordClient implements ThreadCapableClient {
  private readonly botToken: string
  private readonly guildId: string
  private readonly allowedUserIds: Set<string>
  private readonly categoryName: string
  private client: Client | null = null
  private guild: Guild | null = null
  private category: CategoryChannel | null = null
  private messageCallback: OnMessageCallback | null = null

  constructor(opts: {
    botToken: string
    guildId: string
    allowedUserIds?: string[]
    categoryName?: string
  }) {
    this.botToken = opts.botToken
    this.guildId = opts.guildId
    this.allowedUserIds = new Set(opts.allowedUserIds ?? [])
    this.categoryName = opts.categoryName ?? 'Claude Agents'
  }

  onMessage(callback: OnMessageCallback): void {
    this.messageCallback = callback
  }

  async sendMessage(chatId: string, text: string, threadId?: string): Promise<void> {
    if (!this.client) return
    const channelId = threadId ?? chatId
    const channel = this.client.channels.cache.get(channelId) as TextChannel | undefined
    if (!channel) {
      console.error(`[discord] Channel ${channelId} not found`)
      return
    }

    // Discord message limit is 2000 chars
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= 2000) {
        await channel.send(remaining)
        break
      }
      let breakAt = remaining.lastIndexOf('\n', 2000)
      if (breakAt < 1000) breakAt = 2000
      await channel.send(remaining.slice(0, breakAt))
      remaining = remaining.slice(breakAt)
    }
  }

  async createThread(chatId: string, name: string): Promise<string | null> {
    if (!this.guild) return null

    await this.ensureCategory()

    // sanitize channel name: Discord allows lowercase, numbers, hyphens
    const channelName = name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 100)

    try {
      const channel = await this.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: this.category ?? undefined,
        topic: `Agent: ${name}`,
      })
      console.log(`[discord] Created channel #${channelName} (${channel.id})`)
      return channel.id
    } catch (err) {
      console.error(`[discord] Failed to create channel for ${name}:`, err)
      return null
    }
  }

  async deleteThread(_chatId: string, threadId: string): Promise<boolean> {
    if (!this.client) return false
    try {
      // fetch from API (not cache) to ensure we find it
      const channel = await this.client.channels.fetch(threadId).catch(() => null)
      if (channel) {
        await channel.delete()
      }
      return true
    } catch (err) {
      console.error(`[discord] Failed to delete channel ${threadId}:`, err)
      return false
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    this.client.on(Events.MessageCreate, async (message) => {
      // ignore bot messages
      if (message.author.bot) return

      // sender gating
      if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) {
        return
      }

      // only handle messages from our guild
      if (message.guildId !== this.guildId) return

      console.log(`[discord] Received: "${message.content}" from ${message.author.displayName} in #${(message.channel as TextChannel).name}`)

      if (this.messageCallback) {
        await this.messageCallback({
          text: message.content,
          chatId: this.guildId,
          senderId: message.author.id,
          senderName: message.author.displayName ?? message.author.username,
          threadId: message.channelId,
        })
      }
    })

    // login and wait for ready
    const readyPromise = new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        console.log(`[discord] Logged in as ${readyClient.user.tag}`)
        this.guild = readyClient.guilds.cache.get(this.guildId) ?? null
        if (!this.guild) {
          console.error(`[discord] Guild ${this.guildId} not found. Make sure the bot is in the server.`)
          process.exit(1)
        }
        console.log(`[discord] Connected to server: ${this.guild.name}`)
        resolve()
      })
    })

    await this.client.login(this.botToken)
    await readyPromise
  }

  async start(): Promise<void> {
    if (!this.client) await this.connect()
    // discord.js event loop keeps running via the client — just block forever
    await new Promise(() => {})
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
  }

  // ---------- internals ----------

  private async ensureCategory(): Promise<void> {
    if (this.category || !this.guild) return

    // look for existing category (Discord lowercases names)
    const target = this.categoryName.toLowerCase()
    const existing = this.guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === target
    ) as CategoryChannel | undefined

    if (existing) {
      this.category = existing
      return
    }

    // create the category
    this.category = await this.guild.channels.create({
      name: this.categoryName,
      type: ChannelType.GuildCategory,
    })
    console.log(`[discord] Created category "${this.categoryName}"`)
  }
}
