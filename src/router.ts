#!/usr/bin/env node
/**
 * claude-mux router entrypoint
 *
 * Loads config from .env, creates a Telegram client and core router,
 * and starts everything. Swap TelegramClient for another MessagingClient
 * implementation to support Discord, Slack, WhatsApp, etc.
 *
 * LLM provider is configured via ROUTER_MODEL env var:
 *   anthropic:claude-haiku-4-5-20251001  (default if ANTHROPIC_API_KEY is set)
 *   openai:gpt-5.4-nano
 *   google:gemini-3.1-flash-lite-preview
 */

import { config } from 'dotenv'
config()

import type { LanguageModel } from 'ai'
import { Router } from './core-router.js'
import { TelegramClient } from './clients/telegram.js'

const botToken = process.env.TELEGRAM_BOT_TOKEN
if (!botToken) {
  console.error('TELEGRAM_BOT_TOKEN is required')
  process.exit(1)
}

// ---------- LLM model ----------

async function createModel(): Promise<LanguageModel | undefined> {
  const modelSpec = process.env.ROUTER_MODEL

  if (modelSpec) {
    const [provider, ...rest] = modelSpec.split(':')
    const modelId = rest.join(':')
    if (!modelId) {
      console.error(`Invalid ROUTER_MODEL format: "${modelSpec}". Expected "provider:model-id".`)
      process.exit(1)
    }

    switch (provider) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic')
        return createAnthropic()(modelId)
      }
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai')
        return createOpenAI()(modelId)
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
        return createGoogleGenerativeAI()(modelId)
      }
      default:
        console.error(`Unknown LLM provider: "${provider}". Supported: anthropic, openai, google.`)
        process.exit(1)
    }
  }

  // default: use Anthropic Haiku if API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    return createAnthropic()('claude-haiku-4-5-20251001')
  }

  return undefined
}

// ---------- start ----------

const allowedUserIds = process.env.ALLOWED_USER_IDS
  ?.split(',')
  .map(id => parseInt(id.trim(), 10))

const client = new TelegramClient({ botToken, allowedUserIds })

const router = new Router({
  client,
  model: await createModel(),
  port: parseInt(process.env.ROUTER_PORT ?? '9900', 10),
  host: process.env.ROUTER_HOST ?? '127.0.0.1',
})

router.start()
