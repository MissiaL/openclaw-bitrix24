import type {
  Bitrix24MessageEvent,
  Bitrix24WelcomeEvent,
  Bitrix24BotDeleteEvent,
  Bitrix24V2EventChat,
  IncomingMessage,
  ChatType,
} from './types.js';
import { bbCodeToMarkdown } from './format.js';

/**
 * Coerce a webhook-mode string scalar (or an already-numeric FETCH-mode
 * value) into a number. Webhook mode stringifies everything via PHP's
 * http_build_query (spec §7); missing/empty/unparseable values fall back to
 * `0` rather than `NaN` so downstream consumers never see NaN ids.
 */
function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Derive the legacy single-letter ChatType from a v2 `chat` object.
 * Group vs. private is distinguished by `dialogId` format (`chat{N}` vs a
 * bare `{userId}`) and/or `chat.type` (spec §8).
 */
function mapChatType(chat: Bitrix24V2EventChat): ChatType {
  const isGroupDialog = /^chat\d+$/.test(chat.dialogId);
  if (!isGroupDialog) return 'P';
  if (chat.type === 'open' || chat.type === 'openChannel') return 'O';
  return 'C';
}

/**
 * Parse a raw ONIMBOTV2MESSAGEADD event body into an IncomingMessage.
 * Returns null if the message should be ignored (e.g. no bot id present, or
 * the message was authored by a bot — echo prevention).
 */
export function parseMessageEvent(body: Bitrix24MessageEvent): IncomingMessage | null {
  const { data, auth } = body;

  const bot = data?.bot;
  if (!bot?.id) return null;

  const { message, chat, user } = data;

  // Ignore messages from bots to prevent loops. Webhook mode stringifies
  // the boolean `user.bot` field as "1"/"0" (spec §7).
  if (user?.bot === '1') {
    return null;
  }

  return {
    messageId: toNumber(message.id),
    dialogId: chat.dialogId,
    chatId: toNumber(chat.id),
    text: bbCodeToMarkdown(message.text),
    fromUserId: toNumber(user?.id ?? message.authorId),
    fromUserName: user?.firstName || user?.name || '',
    fromUserLastName: user?.lastName ?? '',
    isBot: false,
    chatType: mapChatType(chat),
    // v2 Message.params.files has no documented sub-schema (spec §11,
    // UNVERIFIABLE) — not parsed here rather than guessed at.
    files: [],
    domain: auth?.domain ?? '',
    applicationToken: auth?.application_token,
    botId: toNumber(bot.id),
    botCode: bot.code,
  };
}

/**
 * Parse a welcome event (ONIMBOTV2JOINCHAT — bot added to chat).
 * dialogId is read from `data.dialogId`, falling back to `data.chat.dialogId`.
 */
export function parseWelcomeEvent(body: Bitrix24WelcomeEvent): {
  dialogId: string;
  chatType: ChatType;
  userId: number;
  botId: number;
  botCode: string;
  domain: string;
} | null {
  const bot = body.data?.bot;
  if (!bot?.id) return null;

  const { chat, user } = body.data;
  const dialogId = body.data.dialogId ?? chat?.dialogId;
  if (!dialogId) return null;

  return {
    dialogId,
    chatType: chat ? mapChatType(chat) : 'P',
    userId: toNumber(user?.id),
    botId: toNumber(bot.id),
    botCode: bot.code,
    domain: body.auth?.domain ?? '',
  };
}

/**
 * Parse a bot delete event (ONIMBOTV2DELETE). Payload is just `{bot: {...}}`
 * — no chat/user/message/language keys (spec §10).
 */
export function parseBotDeleteEvent(body: Bitrix24BotDeleteEvent): {
  botId: number;
  botCode: string;
  domain: string;
} | null {
  const bot = body.data?.bot;
  if (!bot?.id) return null;

  return {
    botId: toNumber(bot.id),
    botCode: bot.code,
    domain: body.auth?.domain ?? '',
  };
}

/**
 * Verify the application token from an incoming event.
 *
 * MUST read the TOP-LEVEL `auth.application_token` (snake_case) — never
 * `data.bot.auth.application_token`, which is a distinct OAuth-style token
 * bundle for making REST calls back as the bot (spec §7 explicit warning).
 */
export function verifyApplicationToken(
  event: { auth?: { application_token?: string } },
  expectedToken: string | undefined,
): boolean {
  // If no expected token stored, skip verification
  if (!expectedToken) return true;
  return event.auth?.application_token === expectedToken;
}
