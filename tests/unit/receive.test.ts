import { describe, it, expect } from 'vitest';
import {
  parseMessageEvent,
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
});
