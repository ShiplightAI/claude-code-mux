#!/usr/bin/env node
/**
 * claude-mux router entrypoint
 *
 * Loads config from .env, creates a Telegram client and core router,
 * and starts everything. Each agent gets its own Telegram forum topic.
 */

import { config } from 'dotenv'
import { resolve } from 'path'
import { appendFileSync, existsSync } from 'fs'
config()

import { Router } from './core-router.js'
import { TelegramClient } from './clients/telegram.js'

const botToken = process.env.TELEGRAM_BOT_TOKEN
if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN is required')
  process.exit(1)
}

// ---------- start ----------

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ?.split(',')
  .map(id => parseInt(id.trim(), 10))

let forumChatId = process.env.TELEGRAM_CHAT_ID

const client = new TelegramClient({
  botToken,
  allowedUserIds,
  forumChatId: forumChatId ? parseInt(forumChatId, 10) : undefined,
})

// auto-detect forum chat ID if not provided
if (!forumChatId) {
  console.log('[router] TELEGRAM_CHAT_ID not set — auto-detecting from recent messages...')
  console.log('[router] Send any message in your forum group if not detected.')
  forumChatId = await client.detectForumChatId() ?? undefined
  if (!forumChatId) {
    console.error('Could not auto-detect forum group chat ID. Either:')
    console.error('  1. Send a message in the forum group, then restart the router')
    console.error('  2. Set TELEGRAM_CHAT_ID in .env')
    process.exit(1)
  }
  console.log(`[router] Auto-detected forum chat ID: ${forumChatId}`)

  // save to .env so future restarts skip auto-detection
  const envPath = resolve(process.cwd(), '.env')
  if (existsSync(envPath)) {
    appendFileSync(envPath, `\nTELEGRAM_CHAT_ID=${forumChatId}\n`)
    console.log(`[router] Saved TELEGRAM_CHAT_ID to .env`)
  }
}

const router = new Router({
  client,
  port: parseInt(process.env.ROUTER_PORT ?? '9900', 10),
  host: process.env.ROUTER_HOST ?? '127.0.0.1',
  forumChatId,
  topicsFile: resolve(process.cwd(), '.claude-mux-topics.json'),
})

router.start()
