/**
 * Telegram messaging client for claude-mux router.
 *
 * Handles Telegram Bot API polling, auto-pairing, sender allowlist,
 * and message chunking (4096 char limit).
 */

import type { MessagingClient, ForumCapableClient, OnMessageCallback } from '../messaging-client.js'

// ---------- types ----------

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    message_thread_id?: number
    is_topic_message?: boolean
    from: { id: number; first_name?: string; username?: string }
    chat: { id: number; is_forum?: boolean }
    text?: string
    date: number
  }
}

// ---------- client ----------

export class TelegramClient implements MessagingClient, ForumCapableClient {
  private readonly tgApi: string
  private readonly allowedUserIds: Set<number>
  private pairedChatId: number | null = null
  private messageCallback: OnMessageCallback | null = null
  private offset = 0

  constructor(opts: { botToken: string; allowedUserIds?: number[]; forumChatId?: number }) {
    this.tgApi = `https://api.telegram.org/bot${opts.botToken}`
    this.allowedUserIds = new Set(opts.allowedUserIds ?? [])
    if (opts.forumChatId) {
      this.pairedChatId = opts.forumChatId
    }
  }

  /** The paired chat ID, if any. Useful for the router to know where to send unsolicited messages. */
  get chatId(): string | null {
    return this.pairedChatId !== null ? String(this.pairedChatId) : null
  }

  onMessage(callback: OnMessageCallback): void {
    this.messageCallback = callback
  }

  async sendMessage(chatId: string, text: string, threadId?: string): Promise<void> {
    const numericChatId = parseInt(chatId, 10)
    // split long messages (telegram limit 4096 chars)
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= 4096) {
        chunks.push(remaining)
        break
      }
      let breakAt = remaining.lastIndexOf('\n', 4096)
      if (breakAt < 2000) breakAt = 4096
      chunks.push(remaining.slice(0, breakAt))
      remaining = remaining.slice(breakAt)
    }
    const payload: Record<string, unknown> = { chat_id: numericChatId }
    if (threadId) payload.message_thread_id = parseInt(threadId, 10)
    for (const chunk of chunks) {
      await this.tgCall('sendMessage', { ...payload, text: chunk })
    }
  }

  async createForumTopic(chatId: string, name: string): Promise<number | null> {
    const result = await this.tgCall('createForumTopic', {
      chat_id: parseInt(chatId, 10),
      name,
    }) as { message_thread_id: number } | undefined
    return result?.message_thread_id ?? null
  }

  async closeForumTopic(chatId: string, threadId: number): Promise<boolean> {
    const result = await this.tgCall('closeForumTopic', {
      chat_id: parseInt(chatId, 10),
      message_thread_id: threadId,
    })
    return result === true
  }

  async deleteForumTopic(chatId: string, threadId: number): Promise<boolean> {
    const result = await this.tgCall('deleteForumTopic', {
      chat_id: parseInt(chatId, 10),
      message_thread_id: threadId,
    })
    return result === true
  }

  /**
   * Auto-detect the forum group chat ID by scanning recent updates.
   * Looks for any message from a group with is_forum=true.
   * Returns the chat ID or null if no forum group found.
   */
  async detectForumChatId(): Promise<string | null> {
    console.log('[telegram] Detecting forum group chat ID from recent updates...')
    const result = await this.tgCall('getUpdates', {
      offset: this.offset,
      timeout: 0,
      allowed_updates: ['message'],
    }) as TgUpdate[] | undefined

    if (!result) return null

    for (const update of result) {
      const msg = update.message
      if (msg?.chat.is_forum) {
        const chatId = String(msg.chat.id)
        console.log(`[telegram] Found forum group: ${chatId}`)
        this.pairedChatId = msg.chat.id
        // advance offset past these updates so they aren't re-processed
        this.offset = update.update_id + 1
        return chatId
      }
    }

    console.log('[telegram] No forum group found in recent updates')
    return null
  }

  async start(): Promise<void> {
    console.log('[telegram] Starting poll loop...')
    while (true) {
      await this.pollOnce()
    }
  }

  // ---------- internals ----------

  private async tgCall(method: string, body?: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${this.tgApi}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = (await resp.json()) as { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }
    if (!json.ok) {
      // rate limited — wait and retry
      if (json.parameters?.retry_after) {
        const wait = json.parameters.retry_after
        console.log(`[telegram] Rate limited on ${method}, retrying in ${wait}s...`)
        await new Promise(r => setTimeout(r, wait * 1000))
        return this.tgCall(method, body)
      }
      console.error(`Telegram API error (${method}):`, json.description)
    }
    return json.result
  }

  private async pollOnce(): Promise<void> {
    try {
      const result = await this.tgCall('getUpdates', {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ['message'],
      }) as TgUpdate[] | undefined

      if (!result) return

      for (const update of result) {
        this.offset = update.update_id + 1

        const msg = update.message
        if (!msg?.text) continue

        const senderId = msg.from.id
        const chatId = msg.chat.id

        // sender gating
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(senderId)) {
          continue
        }

        // auto-pair: remember the chat id for replies
        if (this.pairedChatId === null) {
          this.pairedChatId = chatId
          if (this.allowedUserIds.size === 0) {
            this.allowedUserIds.add(senderId)
          }
          await this.sendMessage(String(chatId), `Paired! Your user ID ${senderId} is now allowed.\nUse /help to see commands.`)
          continue
        }

        console.log(`[telegram] Received: "${msg.text}" from ${msg.from.first_name ?? msg.from.username ?? senderId}${msg.message_thread_id ? ` (thread ${msg.message_thread_id})` : ''}`)

        // deliver to router
        if (this.messageCallback) {
          await this.messageCallback({
            text: msg.text,
            chatId: String(chatId),
            senderId: String(senderId),
            senderName: msg.from.first_name ?? msg.from.username ?? String(senderId),
            threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
          })
        }
      }
    } catch (err) {
      console.error('[telegram] Poll error:', err)
    }
  }
}
