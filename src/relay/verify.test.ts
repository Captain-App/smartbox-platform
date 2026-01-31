/**
 * Tests for Telegram Bot Membership Verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractBotId, getBotInfo, verifyBotInGroup } from './verify';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('extractBotId', () => {
  it('extracts bot ID from valid token', () => {
    expect(extractBotId('123456789:ABCdefGHIjklMNOpqrsTUVwxyz')).toBe('123456789');
    expect(extractBotId('1:x')).toBe('1');
    expect(extractBotId('9999999999:token_part')).toBe('9999999999');
  });

  it('returns null for invalid tokens', () => {
    expect(extractBotId('')).toBeNull();
    expect(extractBotId('no-colon')).toBeNull();
    expect(extractBotId(':starts-with-colon')).toBeNull();
    expect(extractBotId('abc:not-a-number')).toBeNull();
    expect(extractBotId('12.34:decimal')).toBeNull();
  });
});

describe('getBotInfo', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns bot info on success', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: {
            id: 123456789,
            username: 'test_bot',
            first_name: 'Test Bot',
            can_join_groups: true,
            can_read_all_group_messages: false,
          },
        }),
    });

    const info = await getBotInfo('123456789:token');

    expect(info).toEqual({
      id: '123456789',
      username: 'test_bot',
      firstName: 'Test Bot',
      canJoinGroups: true,
      canReadAllGroupMessages: false,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456789:token/getMe'
    );
  });

  it('returns null on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }),
    });

    const info = await getBotInfo('invalid:token');
    expect(info).toBeNull();
  });

  it('returns null on fetch error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const info = await getBotInfo('123:token');
    expect(info).toBeNull();
  });
});

describe('verifyBotInGroup', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns success when bot is a member', async () => {
    // Mock getMe
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: {
            id: 123456789,
            username: 'test_bot',
            first_name: 'Test Bot',
          },
        }),
    });

    // Mock getChatMember
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: {
            status: 'member',
          },
        }),
    });

    const result = await verifyBotInGroup('123456789:token', '-1001234567890');

    expect(result).toEqual({
      ok: true,
      botId: '123456789',
      botName: 'test_bot',
      status: 'member',
    });
  });

  it('returns success for administrator status', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 123, username: 'admin_bot', first_name: 'Admin' },
        }),
    });

    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { status: 'administrator' },
        }),
    });

    const result = await verifyBotInGroup('123:token', '-100123');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('administrator');
  });

  it('returns error for invalid token format', async () => {
    const result = await verifyBotInGroup('invalid-token', '-100123');

    expect(result).toEqual({
      ok: false,
      error: 'Invalid bot token format',
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when bot is not in group', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 123, username: 'bot', first_name: 'Bot' },
        }),
    });

    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 400,
          description: 'Bad Request: user not found',
        }),
    });

    const result = await verifyBotInGroup('123:token', '-100123');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Bot is not a member of this group');
  });

  it('returns error when bot was kicked', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 123, username: 'bot', first_name: 'Bot' },
        }),
    });

    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was kicked',
        }),
    });

    const result = await verifyBotInGroup('123:token', '-100123');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Bot was kicked from this group');
  });

  it('returns error for "left" status', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 123, username: 'bot', first_name: 'Bot' },
        }),
    });

    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          result: { status: 'left' },
        }),
    });

    const result = await verifyBotInGroup('123:token', '-100123');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('left');
    expect(result.error).toContain('must be member');
  });
});
