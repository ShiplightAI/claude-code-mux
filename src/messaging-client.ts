/** A message received from the messaging platform */
export interface InboundMessage {
  text: string
  chatId: string
  senderId: string
  senderName: string
  /** Forum topic / thread ID (platform-specific). Present when the message is in a thread. */
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

  /** Start the client (polling, webhook, etc). Called once by the router. */
  start(): Promise<void>

  /** Optional cleanup */
  stop?(): Promise<void>
}

/**
 * A messaging client that supports forum topics / threads.
 * Used by the router in forum mode to create per-agent topics.
 */
export interface ForumCapableClient extends MessagingClient {
  createForumTopic(chatId: string, name: string): Promise<number | null>
  closeForumTopic(chatId: string, threadId: number): Promise<boolean>
  deleteForumTopic(chatId: string, threadId: number): Promise<boolean>
}
