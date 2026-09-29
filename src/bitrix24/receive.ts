import { timingSafeEqual } from 'node:crypto';
import type {
  Bitrix24MessageEvent,
  Bitrix24WelcomeEvent,
  Bitrix24BotDeleteEvent,
  Bitrix24V2EventChat,
  IncomingMessage,
  ChatType,
  FileAttachment,
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
 * Extract inbound file attachments from a v2 message event.
 *
 * LIVE-VERIFIED 2026-07-07: a user-attached document arrives as
 * `message.params.FILE_ID: ["915877"]` — an array of Drive file id strings
 * (or a single scalar) with no name/size metadata; those come from the
 * download response headers (see files.ts:downloadFile).
 */
function extractInboundFiles(params: Record<string, unknown> | undefined): FileAttachment[] {
  const raw = params?.FILE_ID;
  const ids = (Array.isArray(raw) ? raw : [raw])
    .filter((id) => typeof id === 'string' || typeof id === 'number')
    .map((id) => String(id).trim())
    .filter((id) => id !== '');
  return [...new Set(ids)].map((id) => ({ id }));
}

/**
 * Extract the quoted/replied-to message id. LIVE-VERIFIED 2026-07-07: a
 * quote arrives as `message.params.REPLY_ID: "1922495"` — the id only, no
 * quoted content (resolve the content from the channel's recent-message
 * cache; no REST read method is available to a regular chat bot —
 * imbot.v2.Chat.Message.get is supervisor/personal-bot only and
 * im.dialog.messages.get is denied for the bot's own dialog).
 */
function extractReplyToMessageId(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const raw = params?.REPLY_ID;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const id = String(raw).trim();
    if (id !== '') return id;
  }
  return undefined;
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

  // Ignore messages from bots to prevent loops. Webhook mode stringifies the
  // boolean `user.bot` field as "1"/"0" (spec §7), but `createWebhookApp` also
  // accepts `application/json` bodies (express.json()), where a real Bitrix24
  // portal or a test fixture may send a native JSON boolean instead — accept
  // both representations.
  if (user?.bot === '1' || (user?.bot as unknown) === true) {
    return null;
  }

  // Drop system messages (authorId 0, e.g. join/leave notices) — these are
  // not user content and should not be forwarded to the agent. Same
  // string/boolean duality as `user.bot` above.
  if (message.isSystem === '1' || (message.isSystem as unknown) === true) {
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
    files: extractInboundFiles(message.params),
    replyToMessageId: extractReplyToMessageId(message.params),
    domain: auth?.domain ?? '',
    applicationToken: auth?.application_token,
    botId: toNumber(bot.id),
    botCode: bot.code,
  };
}

/**
 * Parse an ONIMBOTV2COMMANDADD event (registered slash command invoked by
 * typing, keyboard button, or context menu) into the same IncomingMessage
 * shape as a plain message, with `text` normalized to "/command args" so the
 * host's native text-command handling picks it up.
 *
 * The command payload location is not pinned by docs (TODO(live-verify)):
 * checked defensively under `data.command` and `data.message.command`, with
 * `message.text` as-is when it already carries the slash form.
 */
export function parseCommandEvent(body: Bitrix24MessageEvent): IncomingMessage | null {
  const msg = parseMessageEvent(body);
  if (!msg) return null;

  if (!msg.text.trim().startsWith('/')) {
    const data = (body as { data?: Record<string, unknown> }).data ?? {};
    const rawCommand =
      (data.command as Record<string, unknown> | string | undefined) ??
      ((data.message as Record<string, unknown> | undefined)?.command as
        | Record<string, unknown>
        | string
        | undefined);
    const name =
      typeof rawCommand === 'object' && rawCommand !== null
        ? String(rawCommand.command ?? rawCommand.name ?? '')
        : String(rawCommand ?? '');
    const params =
      typeof rawCommand === 'object' && rawCommand !== null
        ? String(rawCommand.params ?? rawCommand.commandParams ?? '')
        : '';
    const clean = name.trim().replace(/^\//, '');
    if (clean !== '') {
      msg.text = `/${clean}${params.trim() !== '' ? ` ${params.trim()}` : ''}`;
    }
  }

  return msg.text.trim().startsWith('/') ? msg : null;
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
  // No token pinned yet (undefined/null) => accept (TOFU bootstrap). A
  // pinned token — including the degenerate empty string '' — must match
  // exactly; treating '' as "no token" would fail open for every event.
  if (expectedToken === undefined || expectedToken === null) return true;

  const actual = event.auth?.application_token;
  if (typeof actual !== 'string') return false;

  // Constant-time comparison: a naive `===` leaks timing information
  // proportional to the length of the matching prefix, which could help an
  // attacker brute-force the pinned token byte-by-byte. `timingSafeEqual`
  // requires equal-length buffers, so the length check itself (a cheap,
  // non-secret comparison) must happen first.
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}
