import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createWebhookApp } from '../../src/bitrix24/webhook-server.js';
import type {
  Bitrix24MessageEvent,
  Bitrix24WelcomeEvent,
  Bitrix24BotDeleteEvent,
  IncomingMessage,
} from '../../src/bitrix24/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function startServer(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// imbot.v2 webhook payloads: nested camelCase, all scalars arrive as strings
// (PHP http_build_query serialization — spec §7).

const ACCOUNT_ID = 'acct-test-123';
const APP_TOKEN = 'test-app-token-abc';

function makeMessageEvent(overrides?: {
  isBot?: string;
  appToken?: string;
  text?: string;
  dialogId?: string;
  chatType?: string;
}): Bitrix24MessageEvent {
  return {
    event: 'ONIMBOTV2MESSAGEADD',
    data: {
      bot: { id: '42', code: 'openclaw' },
      message: {
        id: '5001',
        chatId: '200',
        authorId: '7',
        text: overrides?.text ?? 'Hello bot!',
        isSystem: '0',
      },
      chat: {
        id: '200',
        dialogId: overrides?.dialogId ?? 'chat200',
        type: overrides?.chatType ?? 'chat',
      },
      user: {
        id: '7',
        name: 'Ivan Petrov',
        firstName: 'Ivan',
        lastName: 'Petrov',
        bot: overrides?.isBot ?? '0',
      },
      language: 'ru',
    },
    ts: '1772093963',
    auth: {
      domain: 'test.bitrix24.ru',
      application_token: overrides?.appToken ?? APP_TOKEN,
    },
  };
}

function makeWelcomeEvent(): Bitrix24WelcomeEvent {
  return {
    event: 'ONIMBOTV2JOINCHAT',
    data: {
      bot: { id: '42', code: 'openclaw' },
      dialogId: 'chat200',
      chat: { id: '200', dialogId: 'chat200', type: 'chat' },
      user: { id: '7', name: 'Ivan Petrov', firstName: 'Ivan', lastName: 'Petrov' },
      language: 'ru',
    },
    auth: { domain: 'test.bitrix24.ru', application_token: APP_TOKEN },
  };
}

function makeBotDeleteEvent(): Bitrix24BotDeleteEvent {
  return {
    event: 'ONIMBOTV2DELETE',
    data: { bot: { id: '42', code: 'openclaw' } },
    auth: { domain: 'test.bitrix24.ru' },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Webhook server integration', () => {
  let server: Server;
  let baseUrl: string;
  let onMessage: ReturnType<typeof vi.fn>;
  let onWelcome: ReturnType<typeof vi.fn>;
  let onBotDelete: ReturnType<typeof vi.fn>;
  let getApplicationToken: ReturnType<typeof vi.fn>;
  let captureApplicationToken: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    onMessage = vi.fn();
    onWelcome = vi.fn();
    onBotDelete = vi.fn();
    getApplicationToken = vi.fn();
    captureApplicationToken = vi.fn();

    const app = createWebhookApp({
      onMessage,
      onWelcome,
      onBotDelete,
      getApplicationToken,
      captureApplicationToken,
    });

    const started = await startServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  beforeEach(() => {
    onMessage.mockReset();
    onWelcome.mockReset();
    onBotDelete.mockReset();
    getApplicationToken.mockReset();
    captureApplicationToken.mockReset();
  });

  // ── Message dispatch (ONIMBOTV2MESSAGEADD) ──────────────────────────────

  describe('POST /webhook/bitrix24/:accountId — ONIMBOTV2MESSAGEADD', () => {
    it('should call onMessage with parsed IncomingMessage for a group-chat message', async () => {
      // No stored token -> verification skipped
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent({ text: 'Ping!' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });

      expect(onMessage).toHaveBeenCalledOnce();
      const [accountId, msg] = onMessage.mock.calls[0] as [string, IncomingMessage];
      expect(accountId).toBe(ACCOUNT_ID);
      expect(msg.messageId).toBe(5001);
      expect(msg.dialogId).toBe('chat200');
      expect(msg.text).toBe('Ping!');
      expect(msg.fromUserId).toBe(7);
      expect(msg.fromUserName).toBe('Ivan');
      expect(msg.fromUserLastName).toBe('Petrov');
      expect(msg.isBot).toBe(false);
      expect(msg.chatType).toBe('C');
      expect(msg.botId).toBe(42);
      expect(msg.botCode).toBe('openclaw');
      expect(msg.domain).toBe('test.bitrix24.ru');
      expect(msg.applicationToken).toBe(APP_TOKEN);
      expect(msg.files).toEqual([]);
    });

    it('should call onMessage with dialogId unchanged for a private-chat message', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent({ dialogId: '7', chatType: 'chat' });
      event.data.chat.id = '7';
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      const msg = onMessage.mock.calls[0][1] as IncomingMessage;
      expect(msg.dialogId).toBe('7');
      expect(msg.chatType).toBe('P');
    });

    it('should NOT call onMessage when the sender is a bot (user.bot = "1")', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent({ isBot: '1' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should return 403 when the top-level application token does not match', async () => {
      getApplicationToken.mockReturnValue('expected-secret-token');

      const event = makeMessageEvent({ appToken: 'wrong-token' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid application token' });
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should pass token verification when tokens match', async () => {
      getApplicationToken.mockReturnValue(APP_TOKEN);

      const event = makeMessageEvent({ appToken: APP_TOKEN });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
    });

    it('should pass the correct accountId from the URL parameter', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const customAccountId = 'portal-xyz-999';
      const event = makeMessageEvent();
      const res = await post(baseUrl, `/webhook/bitrix24/${customAccountId}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0][0]).toBe(customAccountId);
    });

    it('should convert BB-code in message text to markdown', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent({ text: '[b]Bold[/b] and [i]italic[/i]' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      const msg = onMessage.mock.calls[0][1] as IncomingMessage;
      expect(msg.text).toBe('**Bold** and *italic*');
    });
  });

  // ── Welcome dispatch (ONIMBOTV2JOINCHAT) ────────────────────────────────

  describe('POST /webhook/bitrix24/:accountId — ONIMBOTV2JOINCHAT', () => {
    it('should call onWelcome with parsed event data', async () => {
      const event = makeWelcomeEvent();
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });

      expect(onWelcome).toHaveBeenCalledOnce();
      const [accountId, parsed] = onWelcome.mock.calls[0];
      expect(accountId).toBe(ACCOUNT_ID);
      expect(parsed).toEqual({
        dialogId: 'chat200',
        chatType: 'C',
        userId: 7,
        botId: 42,
        botCode: 'openclaw',
        domain: 'test.bitrix24.ru',
      });
    });

    it('should not call onWelcome when the bot object has no id', async () => {
      const event = makeWelcomeEvent();
      event.data.bot = { id: '', code: '' };

      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onWelcome).not.toHaveBeenCalled();
    });
  });

  // ── Delete dispatch (ONIMBOTV2DELETE) ───────────────────────────────────

  describe('POST /webhook/bitrix24/:accountId — ONIMBOTV2DELETE', () => {
    it('should call onBotDelete with parsed event data (payload is only {bot: {...}})', async () => {
      const event = makeBotDeleteEvent();
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });

      expect(onBotDelete).toHaveBeenCalledOnce();
      const [accountId, parsed] = onBotDelete.mock.calls[0];
      expect(accountId).toBe(ACCOUNT_ID);
      expect(parsed).toEqual({
        botId: 42,
        botCode: 'openclaw',
        domain: 'test.bitrix24.ru',
      });
    });

    it('should not call onBotDelete when the bot object has no id', async () => {
      const event = makeBotDeleteEvent();
      event.data.bot = { id: '', code: '' };

      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onBotDelete).not.toHaveBeenCalled();
    });
  });

  // ── TOFU application_token pinning ──────────────────────────────────────

  describe('Trust-on-first-use application_token pinning', () => {
    it('(a) accepts the first event for an account with no stored token AND captures/persists it', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent({ appToken: 'freshly-seen-token' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(captureApplicationToken).toHaveBeenCalledOnce();
      expect(captureApplicationToken).toHaveBeenCalledWith(ACCOUNT_ID, 'freshly-seen-token');
    });

    it('(a) does not capture anything on first event when the event itself carries no token', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent();
      delete (event as any).auth;
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(captureApplicationToken).not.toHaveBeenCalled();
    });

    it('(b) accepts a subsequent event whose token matches the stored (pinned) token', async () => {
      getApplicationToken.mockReturnValue(APP_TOKEN);

      const event = makeMessageEvent({ appToken: APP_TOKEN });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      // Already pinned -> no re-capture on the verify path.
      expect(captureApplicationToken).not.toHaveBeenCalled();
    });

    it('(c) rejects with 403 when the token differs from the pinned token, and does NOT invoke the handler', async () => {
      getApplicationToken.mockReturnValue(APP_TOKEN);

      const event = makeMessageEvent({ appToken: 'forged-token' });
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid application token' });
      expect(onMessage).not.toHaveBeenCalled();
      expect(captureApplicationToken).not.toHaveBeenCalled();
    });

    it('(d) rejects with 403 when a token is pinned but the event omits it entirely (fail closed)', async () => {
      getApplicationToken.mockReturnValue(APP_TOKEN);

      const event = makeMessageEvent();
      delete (event as any).auth;
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(403);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('(e) gates ONIMBOTV2JOINCHAT the same way: first event captures, mismatched token is rejected', async () => {
      getApplicationToken.mockReturnValue(undefined);
      let event = makeWelcomeEvent();
      let res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);
      expect(res.status).toBe(200);
      expect(onWelcome).toHaveBeenCalledOnce();
      expect(captureApplicationToken).toHaveBeenCalledWith(ACCOUNT_ID, APP_TOKEN);

      onWelcome.mockReset();
      captureApplicationToken.mockReset();
      getApplicationToken.mockReturnValue(APP_TOKEN);
      event = makeWelcomeEvent();
      event.auth = { domain: 'test.bitrix24.ru', application_token: 'wrong-token' };
      res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);
      expect(res.status).toBe(403);
      expect(onWelcome).not.toHaveBeenCalled();
    });

    it('(e) gates ONIMBOTV2DELETE the same way: first event captures, mismatched token is rejected', async () => {
      getApplicationToken.mockReturnValue(undefined);
      let event = makeBotDeleteEvent();
      event.auth = { domain: 'test.bitrix24.ru', application_token: APP_TOKEN };
      let res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);
      expect(res.status).toBe(200);
      expect(onBotDelete).toHaveBeenCalledOnce();
      expect(captureApplicationToken).toHaveBeenCalledWith(ACCOUNT_ID, APP_TOKEN);

      onBotDelete.mockReset();
      captureApplicationToken.mockReset();
      getApplicationToken.mockReturnValue(APP_TOKEN);
      event = makeBotDeleteEvent();
      event.auth = { domain: 'test.bitrix24.ru', application_token: 'wrong-token' };
      res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);
      expect(res.status).toBe(403);
      expect(onBotDelete).not.toHaveBeenCalled();
    });
  });

  // ── Unknown events ───────────────────────────────────────────────────────

  describe('Unknown events', () => {
    it('should ack an unrecognized event with 200 {success:true} and call no handler', async () => {
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, {
        event: 'ONIMBOTV2MESSAGEUPDATE',
        data: {},
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });
      expect(onMessage).not.toHaveBeenCalled();
      expect(onWelcome).not.toHaveBeenCalled();
      expect(onBotDelete).not.toHaveBeenCalled();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('should handle missing auth block in message event gracefully', async () => {
      getApplicationToken.mockReturnValue(undefined);

      const event = makeMessageEvent();
      delete (event as any).auth;

      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      // verifyApplicationToken returns true when no expected token
      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      const msg = onMessage.mock.calls[0][1] as IncomingMessage;
      expect(msg.domain).toBe('');
      expect(msg.applicationToken).toBeUndefined();
    });

    it('should handle missing auth block in welcome event gracefully', async () => {
      const event = makeWelcomeEvent();
      delete (event as any).auth;

      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, event);

      expect(res.status).toBe(200);
      expect(onWelcome).toHaveBeenCalledOnce();
      const parsed = onWelcome.mock.calls[0][1];
      expect(parsed.domain).toBe('');
    });

    it('should return 404 for the old per-event sub-paths removed by the v2 migration', async () => {
      const resMessage = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}/message`, {});
      const resWelcome = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}/welcome`, {});
      const resDelete = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}/delete`, {});

      expect(resMessage.status).toBe(404);
      expect(resWelcome.status).toBe(404);
      expect(resDelete.status).toBe(404);
    });
  });
});

describe('createWebhookApp', () => {
  it('parses form-urlencoded PHP-style nested bodies (Bitrix24 native webhook format)', async () => {
    const onMessage = vi.fn();
    const app = createWebhookApp({ onMessage });
    const { server, baseUrl } = await startServer(app);
    try {
      const params = new URLSearchParams();
      params.set('event', 'ONIMBOTV2MESSAGEADD');
      params.set('data[bot][id]', '42');
      params.set('data[bot][code]', 'openclaw_acct-test-123');
      params.set('data[message][id]', '9001');
      params.set('data[message][chatId]', '55');
      params.set('data[message][authorId]', '7');
      params.set('data[message][text]', 'privet');
      params.set('data[message][isSystem]', '0');
      params.set('data[chat][id]', '55');
      params.set('data[chat][dialogId]', 'chat55');
      params.set('data[chat][type]', 'chat');
      params.set('data[user][id]', '7');
      params.set('data[user][name]', 'Test User');
      params.set('data[user][bot]', '0');
      params.set('auth[domain]', 'test.bitrix24.ru');
      params.set('auth[application_token]', 'urlencoded-token');

      const res = await fetch(`${baseUrl}/webhook/bitrix24/${ACCOUNT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      const [accountId, msg] = onMessage.mock.calls[0] as [string, IncomingMessage];
      expect(accountId).toBe(ACCOUNT_ID);
      expect(msg.messageId).toBe(9001);
      expect(msg.chatId).toBe(55);
      expect(msg.dialogId).toBe('chat55');
      expect(msg.text).toBe('privet');
      expect(msg.fromUserId).toBe(7);
      expect(msg.chatType).toBe('C');
      expect(msg.domain).toBe('test.bitrix24.ru');
      expect(msg.applicationToken).toBe('urlencoded-token');
    } finally {
      await stopServer(server);
    }
  });

  it('parses JSON bodies', async () => {
    const onMessage = vi.fn();
    const app = createWebhookApp({ onMessage });
    const { server, baseUrl } = await startServer(app);
    try {
      const res = await post(baseUrl, `/webhook/bitrix24/${ACCOUNT_ID}`, makeMessageEvent());
      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
    } finally {
      await stopServer(server);
    }
  });
});
