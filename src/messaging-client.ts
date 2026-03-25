/** A message received from the messaging platform */
export interface InboundMessage {
  text: string
  chatId: string
  senderId: string
  senderName: string
  /** Thread / channel ID (platform-specific). Present when the message is in a thread/channel. */
  threadId?: string
}

/** Callback the client calls when a message arrives */
export type OnMessageCallback = (msg: InboundMessage) => Promise<void>

/**
 * Interface that any messaging platform must implement.
 * The router calls sendMessage(); the client calls onMessage() when a user sends something.
 */
export interface MessagingClient {
  /** Send text to a chat. The client handles platform-specific chunking/limits. */
  sendMessage(chatId: string, text: string, threadId?: string): Promise<void>

  /** Register the handler the router will use to receive messages */
  onMessage(callback: OnMessageCallback): void

  /** Connect and initialize (resolve once ready). Called before start(). */
  connect?(): Promise<void>

  /** Start the event loop (polling, webhook, etc). May block forever. */
  start(): Promise<void>

  /** Optional cleanup */
  stop?(): Promise<void>
}

/**
 * A messaging client that supports per-agent threads/channels.
 * Used by the router to create a thread/channel for each agent.
 */
export interface ThreadCapableClient extends MessagingClient {
  /** Create a thread/channel for an agent. Returns the thread ID or null on failure. */
  createThread(chatId: string, name: string): Promise<string | null>
  /** Delete a thread/channel. */
  deleteThread(chatId: string, threadId: string): Promise<boolean>
}
