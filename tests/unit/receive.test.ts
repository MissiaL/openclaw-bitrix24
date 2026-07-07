import { describe, it, expect } from 'vitest';
import {
  parseMessageEvent,
  parseCommandEvent,
  parseCallbackButtonEvent,
  readCommandName,
  parseWelcomeEvent,
  parseBotDeleteEvent,
  verifyApplicationToken,
} from '../../src/bitrix24/receive.js';
import type {
  Bitrix24MessageEvent,
  Bitrix24WelcomeEvent,
  Bitrix24BotDeleteEvent,
} from '../../src/bitrix24/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// imbot.v2 webhook payloads: nested camelCase, all scalars arrive as strings
// (PHP http_build_query serialization — spec §7).

function makeMessageEvent(overrides: Partial<{
  isBot: string;
  text: string;
  authorId: string;
  applicationToken: string;
  dialogId: string;
  chatId: string;
  chatType: string;
  params: Record<string, unknown>;
}> = {}): Bitrix24MessageEvent {
  const authorId = overrides.authorId ?? '1';
  return {
    event: 'ONIMBOTV2MESSAGEADD',
    data: {
      bot: { id: '456', code: 'openclaw_default' },
      message: {
        id: '789',
        chatId: overrides.chatId ?? '5',
        authorId,
        text: overrides.text ?? 'Hello bot!',
        isSystem: '0',
        params: overrides.params,
      },
      chat: {
        id: overrides.chatId ?? '5',
        dialogId: overrides.dialogId ?? 'chat5',
        type: overrides.chatType ?? 'chat',
      },
      user: {
        id: authorId,
        name: 'John Smith',
        firstName: 'John',
        lastName: 'Smith',
        bot: overrides.isBot ?? '0',
      },
      language: 'en',
    },
    ts: '1772093963',
    auth: { domain: 'x.bitrix24.ru', application_token: overrides.applicationToken ?? 'app-tok' },
  };
}

function makeWelcomeEvent(): Bitrix24WelcomeEvent {
  return {
    event: 'ONIMBOTV2JOINCHAT',
    data: {
      bot: { id: '456', code: 'openclaw_default' },
      dialogId: 'chat5',
      chat: { id: '5', dialogId: 'chat5', type: 'chat' },
      user: { id: '1', name: 'John Smith', firstName: 'John', lastName: 'Smith' },
      language: 'en',
    },
    auth: { domain: 'x.bitrix24.ru', application_token: 'app-tok' },
  };
}

function makeBotDeleteEvent(): Bitrix24BotDeleteEvent {
  return {
    event: 'ONIMBOTV2DELETE',
    data: { bot: { id: '456', code: 'openclaw_default' } },
    auth: { domain: 'x.bitrix24.ru' },
  };
}

// ── parseMessageEvent ────────────────────────────────────────────────────────

describe('parseMessageEvent', () => {
  it('parses a group chat ONIMBOTV2MESSAGEADD event', () => {
    const msg = parseMessageEvent(makeMessageEvent({ text: '[b]Hello[/b] world' }));
    expect(msg).not.toBeNull();
    expect(msg!.messageId).toBe(789);
    expect(msg!.dialogId).toBe('chat5');
    expect(msg!.chatId).toBe(5);
    expect(msg!.text).toBe('**Hello** world'); // BB-code → markdown
    expect(msg!.fromUserId).toBe(1);
    expect(msg!.fromUserName).toBe('John');
    expect(msg!.fromUserLastName).toBe('Smith');
    expect(msg!.isBot).toBe(false);
    expect(msg!.chatType).toBe('C');
    expect(msg!.domain).toBe('x.bitrix24.ru');
    expect(msg!.applicationToken).toBe('app-tok');
    expect(msg!.botId).toBe(456);
    expect(msg!.botCode).toBe('openclaw_default');
  });

  it('parses a private chat message (bare dialogId, no "chat" prefix)', () => {
    const event = makeMessageEvent({ dialogId: '1', chatId: '1', chatType: 'chat' });
    const msg = parseMessageEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.dialogId).toBe('1');
    expect(msg!.chatType).toBe('P');
  });

  it('returns null for messages authored by a bot (user.bot = "1", echo prevention)', () => {
    const msg = parseMessageEvent(makeMessageEvent({ isBot: '1' }));
    expect(msg).toBeNull();
  });

  it('returns null for messages authored by a bot when user.bot is a native JSON boolean true (minor fix b)', () => {
    // createWebhookApp also accepts application/json bodies (express.json()),
    // where a native boolean may arrive instead of webhook-mode's stringified "1".
    const event = makeMessageEvent({ isBot: '1' });
    (event.data.user as any).bot = true;
    const msg = parseMessageEvent(event);
    expect(msg).toBeNull();
  });

  it('does not treat user.bot = "0" or false as a bot echo', () => {
    const event = makeMessageEvent({ isBot: '0' });
    expect(parseMessageEvent(event)).not.toBeNull();

    (event.data.user as any).bot = false;
    expect(parseMessageEvent(event)).not.toBeNull();
  });

  it('drops system messages (message.isSystem = "1") — not forwarded to the agent', () => {
    const event = makeMessageEvent({});
    (event.data.message as any).isSystem = '1';
    expect(parseMessageEvent(event)).toBeNull();
  });

  it('drops system messages when message.isSystem is a native JSON boolean true', () => {
    const event = makeMessageEvent({});
    (event.data.message as any).isSystem = true;
    expect(parseMessageEvent(event)).toBeNull();
  });

  it('does not drop a normal message when isSystem is "0" or false', () => {
    const event = makeMessageEvent({});
    (event.data.message as any).isSystem = '0';
    expect(parseMessageEvent(event)).not.toBeNull();

    (event.data.message as any).isSystem = false;
    expect(parseMessageEvent(event)).not.toBeNull();
  });

  it('returns null when the bot object has no id', () => {
    const event = makeMessageEvent({});
    event.data.bot = { id: '', code: '' };
    expect(parseMessageEvent(event)).toBeNull();
  });

  it('coerces webhook-mode string scalars to numbers for id fields', () => {
    const msg = parseMessageEvent(makeMessageEvent({}));
    expect(typeof msg!.messageId).toBe('number');
    expect(typeof msg!.fromUserId).toBe('number');
    expect(typeof msg!.chatId).toBe('number');
    expect(typeof msg!.botId).toBe('number');
  });

  it('defaults to an empty files array when no files are present', () => {
    const msg = parseMessageEvent(makeMessageEvent({}));
    expect(msg!.files).toEqual([]);
  });

  // ── Inbound files (spec §11 — UNVERIFIABLE, defensive parsing) ────────────

  it('extracts files from params.files as an ARRAY', () => {
    const event = makeMessageEvent({
      params: { files: [{ id: 138, name: 'report.pdf', size: 35341 }] },
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '138', name: 'report.pdf', size: 35341 }]);
  });

  it('extracts files from params.files as an OBJECT MAP', () => {
    const event = makeMessageEvent({
      params: { files: { f1: { id: 200, name: 'photo.jpg', size: 999 } } },
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '200', name: 'photo.jpg', size: 999 }]);
  });

  it('extracts a [disk=N] BBCode token from message.text (case-insensitive)', () => {
    const event = makeMessageEvent({ text: 'here is a file [DISK=321] enjoy' });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '321' }]);
  });

  it('extracts the legacy [DISK FILE ID=N] BBCode token from message.text', () => {
    const event = makeMessageEvent({ text: 'see attachment [disk file id=555]' });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '555' }]);
  });

  it('de-duplicates a file id present in both params.files and a text token', () => {
    const event = makeMessageEvent({
      params: { files: [{ id: 138, name: 'report.pdf', size: 35341 }] },
      text: 'file attached [disk=138]',
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toHaveLength(1);
    expect(msg!.files[0]).toEqual({ id: '138', name: 'report.pdf', size: 35341 });
  });

  it('handles multiple distinct files across array + text tokens', () => {
    const event = makeMessageEvent({
      params: { files: [{ id: 1, name: 'a.txt', size: 10 }] },
      text: 'also see [disk=2] and [DISK FILE ID=3]',
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files.map((f) => f.id).sort()).toEqual(['1', '2', '3']);
  });

  // LIVE-VERIFIED 2026-07-07 on portal portal.example.bitrix24.ru: a real
  // user-attached document arrives as `message.params.FILE_ID: ["915877"]` —
  // an array of Drive file id STRINGS under the uppercase FILE_ID key. None
  // of the previously guessed `params.files` shapes fired.
  it('extracts files from params.FILE_ID array (live-verified v2 shape)', () => {
    const event = makeMessageEvent({
      params: { FILE_ID: ['915877'] },
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '915877' }]);
  });

  it('extracts a single scalar params.FILE_ID', () => {
    const event = makeMessageEvent({
      params: { FILE_ID: 915877 },
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toEqual([{ id: '915877' }]);
  });

  // LIVE-VERIFIED 2026-07-07: quoting/replying to a message arrives as
  // `message.params.REPLY_ID: "1922495"` — only the id, no quoted content.
  it('extracts params.REPLY_ID into replyToMessageId', () => {
    const event = makeMessageEvent({ params: { REPLY_ID: '1922495' } });
    const msg = parseMessageEvent(event);
    expect(msg!.replyToMessageId).toBe('1922495');
  });

  it('accepts a numeric params.REPLY_ID', () => {
    const event = makeMessageEvent({ params: { REPLY_ID: 777 } });
    const msg = parseMessageEvent(event);
    expect(msg!.replyToMessageId).toBe('777');
  });

  it('leaves replyToMessageId undefined without params.REPLY_ID', () => {
    const msg = parseMessageEvent(makeMessageEvent({}));
    expect(msg!.replyToMessageId).toBeUndefined();
  });

  it('de-duplicates FILE_ID against params.files entries', () => {
    const event = makeMessageEvent({
      params: {
        FILE_ID: ['138'],
        files: [{ id: 138, name: 'report.pdf', size: 35341 }],
      },
    });
    const msg = parseMessageEvent(event);
    expect(msg!.files).toHaveLength(1);
    expect(msg!.files[0]).toEqual({ id: '138', name: 'report.pdf', size: 35341 });
  });
});

// ── parseCommandEvent (ONIMBOTV2COMMANDADD) ──────────────────────────────────

describe('parseCommandEvent', () => {
  it('passes through a message whose text already carries the slash form', () => {
    const msg = parseCommandEvent(makeMessageEvent({ text: '/status' }));
    expect(msg!.text).toBe('/status');
  });

  it('reconstructs "/command params" from data.command when text lacks it', () => {
    const event = makeMessageEvent({ text: '' }) as any;
    event.data.command = { command: 'status', params: 'verbose' };
    const msg = parseCommandEvent(event);
    expect(msg!.text).toBe('/status verbose');
  });

  it('handles a bare string command with a leading slash', () => {
    const event = makeMessageEvent({ text: '' }) as any;
    event.data.command = '/stop';
    const msg = parseCommandEvent(event);
    expect(msg!.text).toBe('/stop');
  });

  it('returns null when no command can be recovered', () => {
    const msg = parseCommandEvent(makeMessageEvent({ text: 'просто текст' }));
    expect(msg).toBeNull();
  });
});

// ── parseCallbackButtonEvent (interactive keyboard callback) ─────────────────

describe('parseCallbackButtonEvent', () => {
  function callbackEvent(params) {
    const e = makeMessageEvent({ text: '' });
    e.data.command = { command: 'openclaw_cb', params, context: 'keyboard' };
    return e;
  }

  it('readCommandName returns the invoked command without a slash', () => {
    expect(readCommandName(callbackEvent('approve_42'))).toBe('openclaw_cb');
  });

  it('feeds the callback value back as plain message text (no slash)', () => {
    const msg = parseCallbackButtonEvent(callbackEvent('approve_42'));
    expect(msg.text).toBe('approve_42');
  });

  it('returns null when the callback carries no value', () => {
    expect(parseCallbackButtonEvent(callbackEvent(''))).toBeNull();
  });
});

// ── parseWelcomeEvent ────────────────────────────────────────────────────────

describe('parseWelcomeEvent', () => {
  it('parses an ONIMBOTV2JOINCHAT event', () => {
    const event = parseWelcomeEvent(makeWelcomeEvent());
    expect(event).not.toBeNull();
    expect(event!.dialogId).toBe('chat5');
    expect(event!.chatType).toBe('C');
    expect(event!.userId).toBe(1);
    expect(event!.botId).toBe(456);
    expect(event!.botCode).toBe('openclaw_default');
    expect(event!.domain).toBe('x.bitrix24.ru');
  });

  it('falls back to data.chat.dialogId when data.dialogId is absent', () => {
    const event = makeWelcomeEvent();
    delete (event.data as any).dialogId;
    const parsed = parseWelcomeEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.dialogId).toBe('chat5');
  });

  it('returns null when the bot object has no id', () => {
    const event = makeWelcomeEvent();
    event.data.bot = { id: '', code: '' };
    expect(parseWelcomeEvent(event)).toBeNull();
  });
});

// ── parseBotDeleteEvent ──────────────────────────────────────────────────────

describe('parseBotDeleteEvent', () => {
  it('parses an ONIMBOTV2DELETE event (payload is only {bot: {...}})', () => {
    const parsed = parseBotDeleteEvent(makeBotDeleteEvent());
    expect(parsed).toEqual({ botId: 456, botCode: 'openclaw_default', domain: 'x.bitrix24.ru' });
  });

  it('returns null when the bot object has no id', () => {
    const event = makeBotDeleteEvent();
    event.data.bot = { id: '', code: '' };
    expect(parseBotDeleteEvent(event)).toBeNull();
  });
});

// ── verifyApplicationToken ───────────────────────────────────────────────────

describe('verifyApplicationToken', () => {
  it('passes when the top-level auth.application_token matches', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abc' } }, 'abc')).toBe(true);
  });

  it('fails when the top-level auth.application_token differs', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abc' } }, 'xyz')).toBe(false);
  });

  it('passes when no expected token is stored (fail-open, TOFU wiring lands in a later task)', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abc' } }, undefined)).toBe(true);
  });

  it('reads the TOP-LEVEL auth.application_token, never data.bot.auth.application_token (spec §7 warning)', () => {
    const body = {
      auth: { application_token: 'top-level-token' },
      data: { bot: { auth: { application_token: 'nested-different-token' } } },
    };
    expect(verifyApplicationToken(body, 'top-level-token')).toBe(true);
    expect(verifyApplicationToken(body, 'nested-different-token')).toBe(false);
  });

  it('fails CLOSED when a token is pinned but the event omits auth entirely (spec §7: "not always present")', () => {
    expect(verifyApplicationToken({}, 'pinned-token')).toBe(false);
  });

  it('fails CLOSED when a token is pinned but the event auth block omits application_token', () => {
    expect(verifyApplicationToken({ auth: {} }, 'pinned-token')).toBe(false);
  });

  it('does not fail open when the pinned token is an empty string (TOFU fail-open guard)', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abc' } }, '')).toBe(false);
  });

  // ── Constant-time comparison (minor fix c) ──────────────────────────────

  it('matches tokens that differ only in length (still uses the length check, not just timingSafeEqual)', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abc' } }, 'abcd')).toBe(false);
    expect(verifyApplicationToken({ auth: { application_token: 'abcd' } }, 'abc')).toBe(false);
  });

  it('matches equal-length tokens that differ only in the last character', () => {
    expect(verifyApplicationToken({ auth: { application_token: 'abcdefgh' } }, 'abcdefgX')).toBe(false);
  });

  it('still matches long equal tokens (exercises the timingSafeEqual path, not just ===)', () => {
    const token = 'a'.repeat(64);
    expect(verifyApplicationToken({ auth: { application_token: token } }, token)).toBe(true);
  });
});
