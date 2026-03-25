#!/usr/bin/env node
/**
 * claude-mux router entrypoint
 *
 * Loads config from .env, detects messaging platforms (Telegram and/or Discord),
 * creates the appropriate clients, and starts the router.
 * Each agent gets its own thread/channel on every connected platform.
 */

import { config } from 'dotenv'
import { resolve } from 'path'
import { appendFileSync, existsSync } from 'fs'
config()

import { Router, type ClientEntry } from './core-router.js'

// ---------- build client list ----------

const clients: ClientEntry[] = []

// Telegram
const telegramToken = process.env.TELEGRAM_BOT_TOKEN
if (telegramToken) {
  const { TelegramClient } = await import('./clients/telegram.js')

  const allowedUserIds = process.env.ALLOWED_USER_IDS
    ?.split(',')
    .map(id => parseInt(id.trim(), 10))

  let chatId = process.env.TELEGRAM_CHAT_ID

  const client = new TelegramClient({
    botToken: telegramToken,
    allowedUserIds,
    forumChatId: chatId ? parseInt(chatId, 10) : undefined,
  })

  // auto-detect forum chat ID if not provided
  if (!chatId) {
    console.log('[telegram] TELEGRAM_CHAT_ID not set — auto-detecting from recent messages...')
    console.log('[telegram] Send any message in your forum group if not detected.')
    chatId = await client.detectForumChatId() ?? undefined
    if (!chatId) {
      console.error('Could not auto-detect Telegram forum group chat ID. Either:')
      console.error('  1. Send a message in the forum group, then restart the router')
      console.error('  2. Set TELEGRAM_CHAT_ID in .env')
      process.exit(1)
    }
    console.log(`[telegram] Auto-detected forum chat ID: ${chatId}`)

    const envPath = resolve(process.cwd(), '.env')
    if (existsSync(envPath)) {
      appendFileSync(envPath, `\nTELEGRAM_CHAT_ID=${chatId}\n`)
      console.log(`[telegram] Saved TELEGRAM_CHAT_ID to .env`)
    }
  }

  clients.push({ name: 'telegram', client, chatId })
}

// Discord
const discordToken = process.env.DISCORD_BOT_TOKEN
if (discordToken) {
  const { DiscordClient } = await import('./clients/discord.js')

  const guildId = process.env.DISCORD_GUILD_ID
  if (!guildId) {
    console.error('DISCORD_GUILD_ID is required (your Discord server ID)')
    process.exit(1)
  }

  const allowedUserIds = process.env.ALLOWED_USER_IDS
    ?.split(',')
    .map(id => id.trim())

  const client = new DiscordClient({
    botToken: discordToken,
    guildId,
    allowedUserIds,
    categoryName: process.env.DISCORD_CATEGORY ?? 'Claude Agents',
  })

  clients.push({ name: 'discord', client, chatId: guildId })
}

if (clients.length === 0) {
  console.error('No messaging platform configured. Set one or both:')
  console.error('  TELEGRAM_BOT_TOKEN — for Telegram')
  console.error('  DISCORD_BOT_TOKEN  — for Discord')
  process.exit(1)
}

// ---------- start ----------

const router = new Router({
  clients,
  port: parseInt(process.env.ROUTER_PORT ?? '9900', 10),
  host: process.env.ROUTER_HOST ?? '127.0.0.1',
  topicsFile: resolve(process.cwd(), '.claude-mux-topics.json'),
})

router.start()
