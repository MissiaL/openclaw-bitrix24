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

// BBCode tokens that MAY reference an attached Drive file inside
// `message.text` — see `extractInboundFiles` below for why both are scanned.
const DISK_TOKEN_PATTERNS = [
  /\[disk=(\d+)\]/gi,
  /\[disk\s+file\s+id\s*=\s*(\d+)\]/gi,
];

/**
 * Defensively extract inbound file attachments from a v2 message event.
 *
 * TODO(live-verify): inbound file shape is undocumented (spec §11) — confirm
 * against a real portal. The v2 docs state only that `message.params` may
 * carry "attach, keyboard, files, and others" (entities.md), with no worked
 * example of a file-bearing `ONIMBOTV2MESSAGEADD` event anywhere in the
 * chat-bots-v2 doc tree. Handles ALL plausible shapes rather than guessing
 * one:
 *   - `params.files` as an ARRAY: `[{id, name, size}, ...]`
 *   - `params.files` as an OBJECT MAP: `{someKey: {id, name, size}, ...}`
 *   - `[disk=<N>]` BBCode tokens in `message.text` — the documented
 *     *outbound* Drive-file-link tag (message-formatting.md); docs never
 *     confirm whether inbound user-sent files also surface this way
 *   - the legacy `[DISK FILE ID=<N>]` token form, case-insensitive
 * Entries are de-duplicated by id — a file referenced both structurally
 * (`params.files`) and via a text token yields a single attachment.
 */
function extractInboundFiles(
  params: Record<string, unknown> | undefined,
  text: string,
): FileAttachment[] {
  const byId = new Map<string, FileAttachment>();

  const addFile = (id: string, name?: string, size?: number): void => {
    if (!id || byId.has(id)) return;
    const attachment: FileAttachment = { id };
    if (name !== undefined) attachment.name = name;
    if (size !== undefined) attachment.size = size;
    byId.set(id, attachment);
  };

  const addFromRaw = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const rawId = obj.id ?? obj.ID ?? obj.fileId;
    if (rawId === undefined || rawId === null || rawId === '') return;

    const name =
      typeof obj.name === 'string' ? obj.name
      : typeof obj.NAME === 'string' ? obj.NAME
      : undefined;

    const rawSize = obj.size ?? obj.SIZE;
    let size: number | undefined;
    if (typeof rawSize === 'number') {
      size = rawSize;
    } else if (typeof rawSize === 'string' && rawSize !== '') {
      const n = Number(rawSize);
      if (!Number.isNaN(n)) size = n;
    }

    addFile(String(rawId), name, size);
  };

  const filesParam = params?.files;
  if (Array.isArray(filesParam)) {
    filesParam.forEach(addFromRaw);
  } else if (filesParam && typeof filesParam === 'object') {
    Object.values(filesParam as Record<string, unknown>).forEach(addFromRaw);
  }

  for (const pattern of DISK_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      addFile(match[1]);
    }
  }

  return Array.from(byId.values());
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
    files: extractInboundFiles(message.params, message.text),
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
  // No token pinned yet (undefined/null) => accept (TOFU bootstrap). A
  // pinned token — including the degenerate empty string '' — must match
  // exactly; treating '' as "no token" would fail open for every event.
  if (expectedToken === undefined || expectedToken === null) return true;
  return event.auth?.application_token === expectedToken;
}
