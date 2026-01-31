/**
 * Tests for Relay API Routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { relayRoutes } from './routes';
import type { RelayAppEnv } from './auth';
import type { RelayMembership, RelayMessage, RelayApiKey } from './types';

// Mock the verify module
vi.mock('./verify', () => ({
  verifyBotInGroup: vi.fn(),
  extractBotId: vi.fn((token: string) => {
    const idx = token.indexOf(':');
    return idx > 0 ? token.slice(0, idx) : null;
  }),
}));

// Mock Supabase JWT verification
vi.mock('../../platform/auth/supabase-jwt', () => ({
  verifySupabaseJWT: vi.fn(),
  getUserIdFromPayload: vi.fn((payload: { sub: string }) => payload.sub),
}));

import { verifyBotInGroup } from './verify';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

// Create a mock KV store
function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      if (type === 'json') return JSON.parse(value);
      return value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options: { prefix?: string; limit?: number }) => {
      const keys: Array<{ name: string }> = [];
      for (const key of store.keys()) {
        if (!options.prefix || key.startsWith(options.prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys: keys.slice(0, options.limit || 1000) };
    }),
    _store: store,
  };
}

// Create test app with mock bindings
function createTestApp() {
  const mockKV = createMockKV();

  const app = new Hono<RelayAppEnv>();

  // Add env bindings middleware
  app.use('*', async (c, next) => {
    (c.env as RelayAppEnv['Bindings']) = {
      RELAY: mockKV as unknown as KVNamespace,
      SUPABASE_JWT_SECRET: 'test-secret',
      SUPABASE_URL: 'https://test.supabase.co',
      ADMIN_USER_IDS: 'admin-user-id',
    } as RelayAppEnv['Bindings'];
    await next();
  });

  app.route('/relay', relayRoutes);

  return { app, mockKV };
}

// Mock JWT payload that satisfies the type requirements
const mockJwtPayload = (sub: string) =>
  ({
    sub,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: 'https://test.supabase.co/auth/v1',
  }) as Parameters<typeof verifySupabaseJWT> extends [
    string,
    string,
    string | undefined,
  ]
    ? Awaited<ReturnType<typeof verifySupabaseJWT>>
    : never;

describe('POST /relay/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a bot successfully', async () => {
    const { app, mockKV } = createTestApp();

    vi.mocked(verifyBotInGroup).mockResolvedValueOnce({
      ok: true,
      botId: '123456789',
      botName: 'test_bot',
      status: 'member',
    });

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-1001234567890',
        botToken: '123456789:token',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; botId: string; expiresAt: string };
    expect(body.ok).toBe(true);
    expect(body.botId).toBe('123456789');
    expect(body.expiresAt).toBeDefined();

    // Verify KV was called
    expect(mockKV.put).toHaveBeenCalled();
  });

  it('returns error for missing fields', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: '-100123' }), // Missing botToken
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns error when verification fails', async () => {
    const { app } = createTestApp();

    vi.mocked(verifyBotInGroup).mockResolvedValueOnce({
      ok: false,
      error: 'Bot is not a member of this group',
    });

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-100123',
        botToken: '123:token',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not a member');
  });
});

describe('POST /relay/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts a message successfully', async () => {
    const { app, mockKV } = createTestApp();

    // Set up mock JWT verification - cast to any to satisfy mock types
    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'test_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-jwt',
      },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello world',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify message was stored
    expect(mockKV.put).toHaveBeenCalled();
  });

  it('returns 401 without authentication', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 without group membership', async () => {
    const { app } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-jwt',
      },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not registered');
  });
});

describe('GET /relay/poll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns messages from other bots', async () => {
    const { app, mockKV } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'my_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    // Pre-populate messages
    const msg1: RelayMessage = {
      messageId: 1,
      text: 'Hello from bot A',
      botId: 'other-bot-1',
      botName: 'BotA',
      timestamp: 1706000001,
    };
    const msg2: RelayMessage = {
      messageId: 2,
      text: 'Hello from bot B',
      botId: 'other-bot-2',
      botName: 'BotB',
      timestamp: 1706000002,
    };
    // This message should be filtered out (same bot)
    const ownMsg: RelayMessage = {
      messageId: 3,
      text: 'My own message',
      botId: 'user-123',
      botName: 'my_bot',
      timestamp: 1706000003,
    };

    mockKV._store.set('relay:msg:-100123:000001706000001:1', JSON.stringify(msg1));
    mockKV._store.set('relay:msg:-100123:000001706000002:2', JSON.stringify(msg2));
    mockKV._store.set('relay:msg:-100123:000001706000003:3', JSON.stringify(ownMsg));

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { Authorization: 'Bearer valid-jwt' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RelayMessage[]; nextSince: number };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].botId).toBe('other-bot-1');
    expect(body.messages[1].botId).toBe('other-bot-2');
    expect(body.nextSince).toBe(1706000002);
  });

  it('filters messages by since parameter', async () => {
    const { app, mockKV } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'my_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    const msg1: RelayMessage = {
      messageId: 1,
      text: 'Old message',
      botId: 'other-bot',
      botName: 'Bot',
      timestamp: 1706000001,
    };
    const msg2: RelayMessage = {
      messageId: 2,
      text: 'New message',
      botId: 'other-bot',
      botName: 'Bot',
      timestamp: 1706000010,
    };

    mockKV._store.set('relay:msg:-100123:000001706000001:1', JSON.stringify(msg1));
    mockKV._store.set('relay:msg:-100123:000001706000010:2', JSON.stringify(msg2));

    // Poll with since=1706000001 should only return msg2
    const res = await app.request('/relay/poll?groupId=-100123&since=1706000001', {
      headers: { Authorization: 'Bearer valid-jwt' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RelayMessage[]; nextSince: number };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].timestamp).toBe(1706000010);
  });
});

describe('API Key authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authenticates with valid API key', async () => {
    const { app, mockKV } = createTestApp();

    // Pre-populate API key
    const apiKeyData: RelayApiKey = {
      botId: 'external-bot-123',
      botName: 'ExternalBot',
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    };
    mockKV._store.set('relay:apikey:relay_test123', JSON.stringify(apiKeyData));

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'external-bot-123',
      botName: 'ExternalBot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:external-bot-123:-100123', JSON.stringify(membership));

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { 'X-Relay-Key': 'relay_test123' },
    });

    expect(res.status).toBe(200);
  });

  it('rejects invalid API key', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { 'X-Relay-Key': 'invalid_key' },
    });

    expect(res.status).toBe(401);
  });
});
