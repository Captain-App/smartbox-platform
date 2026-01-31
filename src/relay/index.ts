/**
 * Bot-to-Bot Relay Module
 *
 * Enables bots in Telegram groups to share messages with each other,
 * working around Telegram's restriction that bots can't see other bots' messages.
 */

export { relayRoutes } from './routes';
export { createRelayAuthMiddleware, requireAdminAccess } from './auth';
export type { RelayAppEnv, RelayEnv } from './auth';
export * from './types';
export * from './verify';
