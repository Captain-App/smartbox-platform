/**
 * Telegram Bot Membership Verification
 *
 * Verifies that a bot is actually a member of a Telegram group
 * by calling the Telegram Bot API.
 */

/**
 * Extract the bot ID from a bot token.
 * Token format: {botId}:{secret}
 */
export function extractBotId(botToken: string): string | null {
  const colonIndex = botToken.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }
  const botId = botToken.slice(0, colonIndex);
  // Verify it's a valid number
  if (!/^\d+$/.test(botId)) {
    return null;
  }
  return botId;
}

/**
 * Bot information from Telegram API
 */
export interface BotInfo {
  id: string;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}

/**
 * Get bot information using the getMe API call.
 */
export async function getBotInfo(botToken: string): Promise<BotInfo | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await response.json() as {
      ok: boolean;
      result?: {
        id: number;
        username: string;
        first_name: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
      };
    };

    if (!data.ok || !data.result) {
      console.error('[RELAY-VERIFY] getMe failed:', data);
      return null;
    }

    return {
      id: String(data.result.id),
      username: data.result.username,
      firstName: data.result.first_name,
      canJoinGroups: data.result.can_join_groups ?? false,
      canReadAllGroupMessages: data.result.can_read_all_group_messages ?? false,
    };
  } catch (error) {
    console.error('[RELAY-VERIFY] getMe error:', error);
    return null;
  }
}

/**
 * Chat member status from Telegram API
 */
export type ChatMemberStatus =
  | 'creator'
  | 'administrator'
  | 'member'
  | 'restricted'
  | 'left'
  | 'kicked';

/**
 * Verification result for bot membership
 */
export interface VerificationResult {
  /** Whether verification was successful */
  ok: boolean;
  /** Bot's Telegram user ID */
  botId?: string;
  /** Bot's username/display name */
  botName?: string;
  /** Membership status in the group */
  status?: ChatMemberStatus;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Verify that a bot is a member of a Telegram group.
 *
 * @param botToken - The bot's API token
 * @param groupId - The Telegram group ID (negative number for groups/supergroups)
 * @returns Verification result
 */
export async function verifyBotInGroup(
  botToken: string,
  groupId: string
): Promise<VerificationResult> {
  // Extract bot ID from token
  const botId = extractBotId(botToken);
  if (!botId) {
    return { ok: false, error: 'Invalid bot token format' };
  }

  // Get bot info to verify token is valid
  const botInfo = await getBotInfo(botToken);
  if (!botInfo) {
    return { ok: false, error: 'Failed to get bot info - invalid token?' };
  }

  // Verify the bot ID matches
  if (botInfo.id !== botId) {
    return { ok: false, error: 'Bot ID mismatch' };
  }

  try {
    // Call getChatMember to check if bot is in the group
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${groupId}&user_id=${botId}`
    );
    const data = await response.json() as {
      ok: boolean;
      result?: {
        status: ChatMemberStatus;
      };
      description?: string;
      error_code?: number;
    };

    if (!data.ok) {
      // Check for specific error codes
      if (data.error_code === 400) {
        return {
          ok: false,
          botId,
          botName: botInfo.username || botInfo.firstName,
          error: 'Bot is not a member of this group',
        };
      }
      if (data.error_code === 403) {
        return {
          ok: false,
          botId,
          botName: botInfo.username || botInfo.firstName,
          error: 'Bot was kicked from this group',
        };
      }
      return {
        ok: false,
        botId,
        botName: botInfo.username || botInfo.firstName,
        error: data.description || 'Failed to check membership',
      };
    }

    const status = data.result?.status;
    if (!status) {
      return {
        ok: false,
        botId,
        botName: botInfo.username || botInfo.firstName,
        error: 'Invalid response from Telegram',
      };
    }

    // Check if status indicates active membership
    const validStatuses: ChatMemberStatus[] = ['creator', 'administrator', 'member'];
    if (!validStatuses.includes(status)) {
      return {
        ok: false,
        botId,
        botName: botInfo.username || botInfo.firstName,
        status,
        error: `Bot status is "${status}" - must be member, administrator, or creator`,
      };
    }

    return {
      ok: true,
      botId,
      botName: botInfo.username || botInfo.firstName,
      status,
    };
  } catch (error) {
    console.error('[RELAY-VERIFY] getChatMember error:', error);
    return {
      ok: false,
      botId,
      botName: botInfo.username || botInfo.firstName,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
