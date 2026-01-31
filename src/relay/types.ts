/**
 * Bot-to-Bot Relay Types
 *
 * These types define the data structures used by the relay system
 * to enable bots to communicate with each other in Telegram groups.
 */

/**
 * Verified group membership for a bot
 */
export interface RelayMembership {
  /** Bot's Telegram user ID */
  botId: string;
  /** Bot's display name/username */
  botName: string;
  /** Telegram group/supergroup ID */
  groupId: string;
  /** When membership was verified via Telegram API */
  verifiedAt: string;
  /** When membership expires and needs re-verification */
  expiresAt: string;
}

/**
 * Message broadcast by a bot for other bots to receive
 */
export interface RelayMessage {
  /** Telegram message ID */
  messageId: number;
  /** Message text content */
  text: string;
  /** Sending bot's Telegram user ID */
  botId: string;
  /** Sending bot's display name/username */
  botName: string;
  /** Unix timestamp when message was sent */
  timestamp: number;
  /** Message this is replying to (if any) */
  replyToMessageId?: number;
  /** Thread/topic ID for supergroups */
  threadId?: number;
  /** URL to media attachment (photo, document, etc.) */
  mediaUrl?: string;
  /** Type of media: photo, document, audio, video, voice, sticker */
  mediaType?: 'photo' | 'document' | 'audio' | 'video' | 'voice' | 'sticker';
}

/**
 * API key for external bot authentication
 */
export interface RelayApiKey {
  /** Bot's Telegram user ID this key authenticates */
  botId: string;
  /** Bot's display name */
  botName: string;
  /** When the key was created */
  createdAt: string;
  /** User ID of admin who created this key */
  createdBy: string;
}

/**
 * Request body for POST /relay/register
 */
export interface RegisterRequest {
  /** Telegram group ID (negative number for groups/supergroups) */
  groupId: string;
  /** Bot token for verification (format: {botId}:{secret}) */
  botToken: string;
}

/**
 * Response from POST /relay/register
 */
export interface RegisterResponse {
  ok: boolean;
  /** Bot's Telegram user ID (extracted from token) */
  botId?: string;
  /** When the registration expires */
  expiresAt?: string;
  /** Error message if not ok */
  error?: string;
}

/**
 * Request body for POST /relay/broadcast
 */
export interface BroadcastRequest {
  /** Telegram group ID */
  groupId: string;
  /** Telegram message ID */
  messageId: number;
  /** Message text content */
  text: string;
  /** Unix timestamp */
  timestamp: number;
  /** Optional: message this is replying to */
  replyToMessageId?: number;
  /** Optional: thread/topic ID */
  threadId?: number;
  /** Optional: URL to media */
  mediaUrl?: string;
  /** Optional: type of media */
  mediaType?: 'photo' | 'document' | 'audio' | 'video' | 'voice' | 'sticker';
}

/**
 * Response from POST /relay/broadcast
 */
export interface BroadcastResponse {
  ok: boolean;
  /** Error message if not ok */
  error?: string;
}

/**
 * Response from GET /relay/poll
 */
export interface PollResponse {
  messages: RelayMessage[];
  /** Timestamp to use for next poll's `since` parameter */
  nextSince: number;
}

/**
 * Request body for POST /relay/keys (admin only)
 */
export interface CreateApiKeyRequest {
  /** Bot's Telegram user ID */
  botId: string;
  /** Bot's display name */
  botName: string;
}

/**
 * Response from POST /relay/keys
 */
export interface CreateApiKeyResponse {
  ok: boolean;
  /** The generated API key (only shown once) */
  apiKey?: string;
  /** Error message if not ok */
  error?: string;
}

/**
 * Authenticated relay context - set by relay auth middleware
 */
export interface RelayAuthContext {
  /** Bot's Telegram user ID */
  botId: string;
  /** Bot's display name */
  botName: string;
  /** Auth method used: 'jwt' for moltworker users, 'apikey' for external bots */
  authMethod: 'jwt' | 'apikey';
}

/**
 * KV key helpers
 */
export const RelayKV = {
  /** Key for bot membership in a group */
  membershipKey: (botId: string, groupId: string) =>
    `relay:membership:${botId}:${groupId}`,

  /** Key prefix for listing memberships by botId */
  membershipPrefixByBot: (botId: string) => `relay:membership:${botId}:`,

  /** Key for a relay message */
  messageKey: (groupId: string, timestamp: number, messageId: number) =>
    `relay:msg:${groupId}:${String(timestamp).padStart(15, '0')}:${messageId}`,

  /** Key prefix for listing messages in a group */
  messagePrefixByGroup: (groupId: string) => `relay:msg:${groupId}:`,

  /** Key prefix for messages since a timestamp */
  messagePrefixSince: (groupId: string, since: number) =>
    `relay:msg:${groupId}:${String(since).padStart(15, '0')}`,

  /** Key for an API key */
  apiKeyKey: (key: string) => `relay:apikey:${key}`,
} as const;

/**
 * TTL constants (in seconds)
 */
export const RelayTTL = {
  /** Membership expires after 7 days */
  MEMBERSHIP: 7 * 24 * 60 * 60, // 604800 seconds
  /** Messages expire after 24 hours */
  MESSAGE: 24 * 60 * 60, // 86400 seconds
} as const;
