import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// Mock axios before any imports that use it
const mockPost = vi.fn();
const mockAxiosInstance = {
  post: mockPost,
  get: vi.fn(),
  defaults: { baseURL: '' },
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
    get: vi.fn(),
  },
}));

import { Bitrix24Channel } from '../../extensions/bitrix24/src/channel.js';
import { setBitrix24Runtime, type PluginRuntime } from '../../extensions/bitrix24/src/runtime.js';
import type { IncomingMessage } from '../../src/bitrix24/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_WEBHOOK_URL = 'https://test-portal.bitrix24.ru/rest/1/abc123secret/';
const TEST_ACCOUNT_ID = 'test-account';
const TEST_WEBHOOK_BASE_URL = 'https://agent.example.com';
const TEST_BOT_CLIENT_ID = createHash('md5')
  .update(TEST_WEBHOOK_URL.replace(/\/$/, ''))
  .digest('hex');

function createMockRuntime(): PluginRuntime {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    config: {},
    webhookBaseUrl: TEST_WEBHOOK_BASE_URL,
    mutateConfigFile: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Apply the `mutate` callback captured from a `mutateConfigFile` call to a
 * fresh draft object and return the value written at the given dot-path
 * segments — this asserts the real effect of the mutate, not just that it
 * ran.
 */
function applyMutateAndRead(mutateConfigFile: ReturnType<typeof vi.fn>, callIndex: number, segments: string[]): unknown {
  const params = mutateConfigFile.mock.calls[callIndex][0];
  const draft: any = {};
  params.mutate(draft);
  return segments.reduce((node: any, seg) => node?.[seg], draft);
}

/** Helper: set up mockPost to return a Bitrix24 API response for a given method. */
function mockApiResponse(method: string, result: any) {
  mockPost.mockImplementation((url: string) => {
    if (url === `/${method}`) {
      return Promise.resolve({ data: { result } });
    }
    // Default: return empty result for any other method (e.g. typing indicator)
    return Promise.resolve({ data: { result: true } });
  });
}

/** Helper: set up mockPost to handle multiple methods with different responses. */
function mockApiResponses(responses: Record<string, any>) {
  mockPost.mockImplementation((url: string) => {
    const method = url.replace('/', '');
    if (method in responses) {
      return Promise.resolve({ data: { result: responses[method] } });
    }
    return Promise.resolve({ data: { result: true } });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Bitrix24Channel integration', () => {
  let channel: Bitrix24Channel;
  let runtime: PluginRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    runtime = createMockRuntime();
    setBitrix24Runtime(runtime);

    channel = new Bitrix24Channel();
    channel.configure({
      accounts: [
        {
          id: TEST_ACCOUNT_ID,
          webhookUrl: TEST_WEBHOOK_URL,
          domain: 'test-portal.bitrix24.ru',
          bot: {
            name: 'Test Bot',
            color: 'PURPLE',
            workPosition: 'Test Assistant',
          },
        },
      ],
    });
  });

  afterEach(() => {
    channel.destroy();
  });

  // ── 1. configure ─────────────────────────────────────────────────────────

  describe('configure', () => {
    it('should register the account from config', () => {
      const accounts = channel.listAccountIds();
      expect(accounts).toContain(TEST_ACCOUNT_ID);
    });

    it('should list enabled accounts with domain', () => {
      const enabled = channel.listEnabledAccounts();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]).toEqual({
        id: TEST_ACCOUNT_ID,
        domain: 'test-portal.bitrix24.ru',
      });
    });

    it('should resolve the account by id', () => {
      const account = channel.resolveAccount(TEST_ACCOUNT_ID);
      expect(account).toBeDefined();
      expect(account!.domain).toBe('test-portal.bitrix24.ru');
      expect(account!.bot.name).toBe('Test Bot');
    });
  });

  // ── 2. startupAccount ────────────────────────────────────────────────────

  describe('startupAccount', () => {
    it('should call imbot.v2.Bot.register and store botId/botCode', async () => {
      const BOT_ID = 42;
      const BOT_CODE = `openclaw_${TEST_ACCOUNT_ID}`;
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      // Verify imbot.v2.Bot.register was called
      const registerCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Bot.register',
      );
      expect(registerCall).toBeDefined();

      const payload = registerCall![1];
      expect(payload.fields.code).toBe(BOT_CODE);
      expect(payload.fields.botToken).toBe(TEST_BOT_CLIENT_ID);
      expect(payload.fields.eventMode).toBe('webhook');
      expect(payload.fields.type).toBe('bot');
      expect(payload.fields.properties.name).toBe('Test Bot');
      expect(payload.fields.properties.color).toBe('PURPLE');
      expect(payload.fields.properties.workPosition).toBe('Test Assistant');
      expect(payload.fields.webhookUrl).toBe(
        `${TEST_WEBHOOK_BASE_URL}/webhook/bitrix24/${TEST_ACCOUNT_ID}`,
      );

      // Verify botId was stored
      const account = channel.resolveAccount(TEST_ACCOUNT_ID);
      expect(account!.botId).toBe(BOT_ID);
      expect(account!.botCode).toBe(BOT_CODE);

      // Verify logger was called
      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Registering Bitrix24 bot'),
      );
      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining(`ID: ${BOT_ID}`),
      );
    });

    it('should skip registration if botId is already set', async () => {
      // First registration
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: 42, code: `openclaw_${TEST_ACCOUNT_ID}` } });
      await channel.startupAccount(TEST_ACCOUNT_ID);

      vi.clearAllMocks();

      // Second call should skip
      await channel.startupAccount(TEST_ACCOUNT_ID);

      expect(mockPost).not.toHaveBeenCalled();
      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already registered'),
      );
    });

    it('should throw if account does not exist', async () => {
      await expect(channel.startupAccount('nonexistent')).rejects.toThrow(
        'Account "nonexistent" not found',
      );
    });
  });

  describe('startupAccount webhook base tracking', () => {
    const BOT_ID = 42;

    it('calls imbot.v2.Bot.update when the public URL changed since registration', async () => {
      runtime.webhookBaseUrl = 'https://new.example';

      const trackingChannel = new Bitrix24Channel();
      trackingChannel.configure({
        registeredWebhookBase: { [TEST_ACCOUNT_ID]: 'https://old.example' },
        accounts: [
          {
            id: TEST_ACCOUNT_ID,
            webhookUrl: TEST_WEBHOOK_URL,
            domain: 'test-portal.bitrix24.ru',
            botId: BOT_ID,
            botCode: `openclaw_${TEST_ACCOUNT_ID}`,
            bot: { name: 'Test Bot', color: 'PURPLE', workPosition: 'Test Assistant' },
          },
        ],
      });

      mockApiResponse('imbot.v2.Bot.update', { bot: { id: BOT_ID } });

      await trackingChannel.startupAccount(TEST_ACCOUNT_ID);

      const updateCall = mockPost.mock.calls.find((call) => call[0] === '/imbot.v2.Bot.update');
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual({
        botId: BOT_ID,
        botToken: TEST_BOT_CLIENT_ID,
        fields: {
          webhookUrl: `https://new.example/webhook/bitrix24/${TEST_ACCOUNT_ID}`,
        },
      });

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const writtenBase = applyMutateAndRead(
        runtime.mutateConfigFile as ReturnType<typeof vi.fn>,
        0,
        ['channels', 'bitrix24', 'registeredWebhookBase', TEST_ACCOUNT_ID],
      );
      expect(writtenBase).toBe('https://new.example');

      trackingChannel.destroy();
    });

    it('does not call imbot.v2.Bot.update when the base is unchanged', async () => {
      runtime.webhookBaseUrl = 'https://same.example';

      const trackingChannel = new Bitrix24Channel();
      trackingChannel.configure({
        registeredWebhookBase: { [TEST_ACCOUNT_ID]: 'https://same.example' },
        accounts: [
          {
            id: TEST_ACCOUNT_ID,
            webhookUrl: TEST_WEBHOOK_URL,
            domain: 'test-portal.bitrix24.ru',
            botId: BOT_ID,
            botCode: `openclaw_${TEST_ACCOUNT_ID}`,
            bot: { name: 'Test Bot', color: 'PURPLE', workPosition: 'Test Assistant' },
          },
        ],
      });

      await trackingChannel.startupAccount(TEST_ACCOUNT_ID);

      const updateCall = mockPost.mock.calls.find((call) => call[0] === '/imbot.v2.Bot.update');
      expect(updateCall).toBeUndefined();
      expect(runtime.mutateConfigFile).not.toHaveBeenCalled();
      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already registered'),
      );

      trackingChannel.destroy();
    });

    it('persists the base after fresh registration', async () => {
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: `openclaw_${TEST_ACCOUNT_ID}` } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const writtenBase = applyMutateAndRead(
        runtime.mutateConfigFile as ReturnType<typeof vi.fn>,
        0,
        ['channels', 'bitrix24', 'registeredWebhookBase', TEST_ACCOUNT_ID],
      );
      expect(writtenBase).toBe(TEST_WEBHOOK_BASE_URL);
    });

    it('calls imbot.v2.Bot.update on first startup after upgrade (botId present, no stored registeredWebhookBase)', async () => {
      // Simulates every existing install on first startup after upgrading to a version
      // that tracks registeredWebhookBase: botId is already set from a prior registration,
      // but the config predates the tracking key entirely (not even an empty map).
      const trackingChannel = new Bitrix24Channel();
      trackingChannel.configure({
        accounts: [
          {
            id: TEST_ACCOUNT_ID,
            webhookUrl: TEST_WEBHOOK_URL,
            domain: 'test-portal.bitrix24.ru',
            botId: BOT_ID,
            botCode: `openclaw_${TEST_ACCOUNT_ID}`,
            bot: { name: 'Test Bot', color: 'PURPLE', workPosition: 'Test Assistant' },
          },
        ],
      });

      mockApiResponse('imbot.v2.Bot.update', { bot: { id: BOT_ID } });

      await trackingChannel.startupAccount(TEST_ACCOUNT_ID);

      const updateCall = mockPost.mock.calls.find((call) => call[0] === '/imbot.v2.Bot.update');
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual({
        botId: BOT_ID,
        botToken: TEST_BOT_CLIENT_ID,
        fields: {
          webhookUrl: `${TEST_WEBHOOK_BASE_URL}/webhook/bitrix24/${TEST_ACCOUNT_ID}`,
        },
      });

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const writtenBase = applyMutateAndRead(
        runtime.mutateConfigFile as ReturnType<typeof vi.fn>,
        0,
        ['channels', 'bitrix24', 'registeredWebhookBase', TEST_ACCOUNT_ID],
      );
      expect(writtenBase).toBe(TEST_WEBHOOK_BASE_URL);

      trackingChannel.destroy();
    });
  });

  // ── 2b. First-startup v2 self-healing (ensureWebhookMode) ────────────────

  describe('startupAccount — first-startup v2 takeover self-healing', () => {
    const BOT_ID = 42;
    const BOT_CODE = `openclaw_${TEST_ACCOUNT_ID}`;

    it('calls imbot.v2.Bot.update (ensureWebhookMode) with eventMode:webhook right after a fresh register', async () => {
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      const updateCall = mockPost.mock.calls.find((call) => call[0] === '/imbot.v2.Bot.update');
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toEqual({
        botId: BOT_ID,
        botToken: TEST_BOT_CLIENT_ID,
        fields: {
          eventMode: 'webhook',
          webhookUrl: `${TEST_WEBHOOK_BASE_URL}/webhook/bitrix24/${TEST_ACCOUNT_ID}`,
        },
      });

      // Register happened before update.
      const callOrder = mockPost.mock.calls.map((call) => call[0]);
      expect(callOrder.indexOf('/imbot.v2.Bot.register')).toBeLessThan(
        callOrder.indexOf('/imbot.v2.Bot.update'),
      );
    });

    it('catches a BOT_OWNERSHIP_ERROR from ensureWebhookMode, warns actionably, and does not throw out of startupAccount', async () => {
      mockPost.mockImplementation((url: string) => {
        if (url === '/imbot.v2.Bot.register') {
          return Promise.resolve({ data: { result: { bot: { id: BOT_ID, code: BOT_CODE } } } });
        }
        if (url === '/imbot.v2.Bot.update') {
          return Promise.resolve({
            data: { error: 'BOT_OWNERSHIP_ERROR', error_description: 'Bot is owned by a different token' },
          });
        }
        return Promise.resolve({ data: { result: true } });
      });

      await expect(channel.startupAccount(TEST_ACCOUNT_ID)).resolves.toBeUndefined();

      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Bitrix24 bot "${BOT_CODE}" exists but is owned by a different token`),
      );
      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Manual re-registration required'),
      );

      // Registration must still have completed — botId/botCode stored.
      const account = channel.resolveAccount(TEST_ACCOUNT_ID);
      expect(account!.botId).toBe(BOT_ID);
      expect(account!.botCode).toBe(BOT_CODE);
    });

    it('does not warn when ensureWebhookMode succeeds', async () => {
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      const warnCalls = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes('owned by a different token'))).toBe(false);
    });

    it('persists botId/botCode into the accounts array upon fresh registration', async () => {
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const params = (runtime.mutateConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      const draft: any = { channels: { bitrix24: { accounts: [{ id: TEST_ACCOUNT_ID, webhookUrl: TEST_WEBHOOK_URL }] } } };
      params.mutate(draft);

      const account = draft.channels.bitrix24.accounts.find((a: any) => a?.id === TEST_ACCOUNT_ID);
      expect(account).toBeDefined();
      expect(account.botId).toBe(BOT_ID);
      expect(account.botCode).toBe(BOT_CODE);
      // registeredWebhookBase (flat map) is written by the same mutate call.
      expect(draft.channels.bitrix24.registeredWebhookBase[TEST_ACCOUNT_ID]).toBe(TEST_WEBHOOK_BASE_URL);
    });

    it('persists botId/botCode even when ensureWebhookMode fails (ownership error)', async () => {
      mockPost.mockImplementation((url: string) => {
        if (url === '/imbot.v2.Bot.register') {
          return Promise.resolve({ data: { result: { bot: { id: BOT_ID, code: BOT_CODE } } } });
        }
        if (url === '/imbot.v2.Bot.update') {
          return Promise.resolve({
            data: { error: 'BOT_OWNERSHIP_ERROR', error_description: 'Bot is owned by a different token' },
          });
        }
        return Promise.resolve({ data: { result: true } });
      });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const params = (runtime.mutateConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const draft: any = {};
      params.mutate(draft);
      const account = draft.channels.bitrix24.accounts.find((a: any) => a?.id === TEST_ACCOUNT_ID);
      expect(account.botId).toBe(BOT_ID);
      expect(account.botCode).toBe(BOT_CODE);
    });

    it('warns (but does not block) when the resolved webhook base looks like localhost/non-https', async () => {
      runtime.webhookBaseUrl = 'http://localhost:18789';
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('looks like localhost/non-https'),
      );
      // Still registers — warning is advisory only.
      const registerCall = mockPost.mock.calls.find((call) => call[0] === '/imbot.v2.Bot.register');
      expect(registerCall).toBeDefined();
    });

    it('does not warn about reachability for a normal https public URL', async () => {
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: BOT_CODE } });

      await channel.startupAccount(TEST_ACCOUNT_ID);

      const warnCalls = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes('localhost/non-https'))).toBe(false);
    });
  });

  // ── 3. sendTextMessage ───────────────────────────────────────────────────

  describe('sendTextMessage', () => {
    const DIALOG_ID = '123';
    const BOT_ID = 42;

    beforeEach(async () => {
      // Register bot first
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: `openclaw_${TEST_ACCOUNT_ID}` } });
      await channel.startupAccount(TEST_ACCOUNT_ID);
      vi.clearAllMocks();

      // Set up default responses for send flow
      mockApiResponses({
        'imbot.v2.Chat.InputAction.notify': { result: true },
        'imbot.v2.Chat.Message.send': { id: 1001, uuidMap: {} },
      });
    });

    it('should send typing indicator then message with BB-code', async () => {
      const text = 'Hello **world**';

      await channel.sendTextMessage(TEST_ACCOUNT_ID, DIALOG_ID, text);

      // Verify typing indicator was sent
      const typingCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Chat.InputAction.notify',
      );
      expect(typingCall).toBeDefined();
      expect(typingCall![1].botToken).toBe(TEST_BOT_CLIENT_ID);
      expect(typingCall![1].botId).toBe(BOT_ID);
      expect(typingCall![1].dialogId).toBe(DIALOG_ID);

      // Verify message was sent with BB-code conversion
      const messageCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Chat.Message.send',
      );
      expect(messageCall).toBeDefined();
      expect(messageCall![1].botToken).toBe(TEST_BOT_CLIENT_ID);
      expect(messageCall![1].botId).toBe(BOT_ID);
      expect(messageCall![1].dialogId).toBe(DIALOG_ID);
      expect(messageCall![1].fields.message).toBe('Hello [b]world[/b]');
    });

    it('should send typing before message (call order)', async () => {
      await channel.sendTextMessage(TEST_ACCOUNT_ID, DIALOG_ID, 'test');

      const callOrder = mockPost.mock.calls.map((call) => call[0]);
      const typingIndex = callOrder.indexOf('/imbot.v2.Chat.InputAction.notify');
      const messageIndex = callOrder.indexOf('/imbot.v2.Chat.Message.send');

      expect(typingIndex).toBeGreaterThanOrEqual(0);
      expect(messageIndex).toBeGreaterThan(typingIndex);
    });

    it('should chunk and send multiple messages for long text (>18000 chars)', async () => {
      // Build text that exceeds the 18000 char limit
      // Use paragraphs so chunking splits at \n\n boundaries
      const paragraph = 'This is a test paragraph with some content. ';
      const longText = Array(500).fill(paragraph).join('\n\n');

      expect(longText.length).toBeGreaterThan(18000);

      let messageIdCounter = 1000;
      mockPost.mockImplementation((url: string) => {
        if (url === '/imbot.v2.Chat.Message.send') {
          messageIdCounter++;
          return Promise.resolve({ data: { result: { id: messageIdCounter, uuidMap: {} } } });
        }
        return Promise.resolve({ data: { result: true } });
      });

      await channel.sendTextMessage(TEST_ACCOUNT_ID, DIALOG_ID, longText);

      // Count message send calls
      const messageCalls = mockPost.mock.calls.filter(
        (call) => call[0] === '/imbot.v2.Chat.Message.send',
      );

      expect(messageCalls.length).toBeGreaterThan(1);

      // All chunks should have correct botId and dialogId
      for (const call of messageCalls) {
        expect(call[1].botToken).toBe(TEST_BOT_CLIENT_ID);
        expect(call[1].botId).toBe(BOT_ID);
        expect(call[1].dialogId).toBe(DIALOG_ID);
        expect(call[1].fields.message).toBeTruthy();
      }

      // Typing indicator should still be sent exactly once
      const typingCalls = mockPost.mock.calls.filter(
        (call) => call[0] === '/imbot.v2.Chat.InputAction.notify',
      );
      expect(typingCalls).toHaveLength(1);
    });

    it('should convert markdown formatting to BB-code', async () => {
      const markdownText = [
        '# Header',
        'Some **bold** and *italic* text',
        '~~strikethrough~~',
        '`inline code`',
        '[Link](https://example.com)',
      ].join('\n');

      await channel.sendTextMessage(TEST_ACCOUNT_ID, DIALOG_ID, markdownText);

      const messageCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Chat.Message.send',
      );
      const sentMessage = messageCall![1].fields.message;

      expect(sentMessage).toContain('[b]Header[/b]');
      expect(sentMessage).toContain('[b]bold[/b]');
      expect(sentMessage).toContain('[i]italic[/i]');
      expect(sentMessage).toContain('[s]strikethrough[/s]');
      expect(sentMessage).toContain('[code]inline code[/code]');
      expect(sentMessage).toContain('[url=https://example.com]Link[/url]');
    });

    it('should throw if account has no botId', async () => {
      // Create a new channel without bot registration
      const freshChannel = new Bitrix24Channel();
      freshChannel.configure({
        accounts: [
          {
            id: 'no-bot',
            webhookUrl: TEST_WEBHOOK_URL,
            domain: 'test-portal.bitrix24.ru',
          },
        ],
      });

      await expect(
        freshChannel.sendTextMessage('no-bot', DIALOG_ID, 'test'),
      ).rejects.toThrow('not configured, bot not registered, or bot token missing');

      freshChannel.destroy();
    });

    it('should still send even if typing indicator fails', async () => {
      mockPost.mockImplementation((url: string) => {
        if (url === '/imbot.v2.Chat.InputAction.notify') {
          return Promise.reject(new Error('Typing API error'));
        }
        return Promise.resolve({ data: { result: { id: 1001, uuidMap: {} } } });
      });

      // Should not throw
      await channel.sendTextMessage(TEST_ACCOUNT_ID, DIALOG_ID, 'test message');

      const messageCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Chat.Message.send',
      );
      expect(messageCall).toBeDefined();
    });
  });

  // ── 4. handleIncomingMessage ─────────────────────────────────────────────

  describe('handleIncomingMessage', () => {
    it('should fire the onMessage callback with accountId and message', () => {
      const callback = vi.fn();
      channel.onMessage(callback);

      const incomingMsg: IncomingMessage = {
        messageId: 555,
        dialogId: '123',
        chatId: 10,
        text: 'Hello from user',
        fromUserId: 1,
        fromUserName: 'Ivan',
        fromUserLastName: 'Petrov',
        isBot: false,
        chatType: 'P',
        files: [],
        domain: 'test-portal.bitrix24.ru',
        botId: 42,
        botCode: `openclaw_${TEST_ACCOUNT_ID}`,
      };

      channel.handleIncomingMessage(TEST_ACCOUNT_ID, incomingMsg);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(TEST_ACCOUNT_ID, incomingMsg);
    });

    it('should not throw if no callback is registered', () => {
      const incomingMsg: IncomingMessage = {
        messageId: 556,
        dialogId: '123',
        text: 'No listener',
        fromUserId: 1,
        fromUserName: 'User',
        fromUserLastName: 'Name',
        isBot: false,
        chatType: 'P',
        files: [],
        domain: 'test-portal.bitrix24.ru',
        botId: 42,
        botCode: 'openclaw_test',
      };

      // Should not throw
      expect(() => {
        channel.handleIncomingMessage(TEST_ACCOUNT_ID, incomingMsg);
      }).not.toThrow();
    });

    it('should pass file attachments in the message', () => {
      const callback = vi.fn();
      channel.onMessage(callback);

      const incomingMsg: IncomingMessage = {
        messageId: 557,
        dialogId: 'chat100',
        text: 'See attached',
        fromUserId: 5,
        fromUserName: 'Maria',
        fromUserLastName: 'Ivanova',
        isBot: false,
        chatType: 'C',
        files: [
          { id: 'file1', name: 'report.pdf', size: 1024, type: 'application/pdf' },
        ],
        domain: 'test-portal.bitrix24.ru',
        botId: 42,
        botCode: `openclaw_${TEST_ACCOUNT_ID}`,
      };

      channel.handleIncomingMessage(TEST_ACCOUNT_ID, incomingMsg);

      const receivedMsg = callback.mock.calls[0][1] as IncomingMessage;
      expect(receivedMsg.files).toHaveLength(1);
      expect(receivedMsg.files[0].name).toBe('report.pdf');
    });
  });

  // ── 4b. TOFU application_token capture ───────────────────────────────────

  describe('getApplicationToken / captureApplicationToken (TOFU)', () => {
    it('returns undefined before any token has been captured', () => {
      expect(channel.getApplicationToken(TEST_ACCOUNT_ID)).toBeUndefined();
    });

    it('captureApplicationToken sets the token in memory immediately', () => {
      channel.captureApplicationToken(TEST_ACCOUNT_ID, 'first-use-token');
      expect(channel.getApplicationToken(TEST_ACCOUNT_ID)).toBe('first-use-token');
    });

    it('captureApplicationToken persists via mutateConfigFile using the accounts-array upsert shape', () => {
      channel.captureApplicationToken(TEST_ACCOUNT_ID, 'persisted-token');

      expect(runtime.mutateConfigFile).toHaveBeenCalledOnce();
      const params = (runtime.mutateConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(params.afterWrite).toEqual({ mode: 'none', reason: 'bitrix24 plugin durability write' });

      const draft: any = {};
      params.mutate(draft);
      const accounts = draft.channels.bitrix24.accounts;
      expect(Array.isArray(accounts)).toBe(true);
      const account = accounts.find((a: any) => a?.id === TEST_ACCOUNT_ID);
      expect(account).toBeDefined();
      expect(account.applicationToken).toBe('persisted-token');
    });

    it('captureApplicationToken upserts into an existing accounts array entry rather than duplicating it', () => {
      channel.captureApplicationToken(TEST_ACCOUNT_ID, 'tok-1');
      const params = (runtime.mutateConfigFile as ReturnType<typeof vi.fn>).mock.calls[0][0];

      const draft: any = { channels: { bitrix24: { accounts: [{ id: TEST_ACCOUNT_ID, webhookUrl: TEST_WEBHOOK_URL }] } } };
      params.mutate(draft);

      expect(draft.channels.bitrix24.accounts).toHaveLength(1);
      expect(draft.channels.bitrix24.accounts[0].applicationToken).toBe('tok-1');
      expect(draft.channels.bitrix24.accounts[0].webhookUrl).toBe(TEST_WEBHOOK_URL);
    });

    it('warns and does not throw when the host does not support durable config writes', () => {
      runtime.mutateConfigFile = undefined;

      expect(() => channel.captureApplicationToken(TEST_ACCOUNT_ID, 'tok')).not.toThrow();
      expect(channel.getApplicationToken(TEST_ACCOUNT_ID)).toBe('tok');
      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not persisted'),
      );
    });
  });

  // ── 5. probeAccount ──────────────────────────────────────────────────────

  describe('probeAccount', () => {
    it('should call user.current and return ok:true on success', async () => {
      mockApiResponse('user.current', {
        ID: '1',
        NAME: 'Admin',
        LAST_NAME: 'User',
      });

      const result = await channel.probeAccount(TEST_ACCOUNT_ID);

      expect(result.ok).toBe(true);

      // Verify user.current was called
      const probeCall = mockPost.mock.calls.find(
        (call) => call[0] === '/user.current',
      );
      expect(probeCall).toBeDefined();
    });

    it('should return ok:false with error on API failure', async () => {
      mockPost.mockImplementation((url: string) => {
        if (url === '/user.current') {
          return Promise.resolve({
            data: {
              result: null,
              error: 'INVALID_TOKEN',
              error_description: 'The access token is invalid',
            },
          });
        }
        return Promise.resolve({ data: { result: true } });
      });

      const result = await channel.probeAccount(TEST_ACCOUNT_ID);

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return ok:false on network error', async () => {
      mockPost.mockImplementation((url: string) => {
        if (url === '/user.current') {
          return Promise.reject(new Error('Network Error'));
        }
        return Promise.resolve({ data: { result: true } });
      });

      const result = await channel.probeAccount(TEST_ACCOUNT_ID);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network Error');
    });
  });

  // ── 6. logoutAccount ─────────────────────────────────────────────────────

  describe('logoutAccount', () => {
    const BOT_ID = 42;

    beforeEach(async () => {
      // Register bot first
      mockApiResponse('imbot.v2.Bot.register', { bot: { id: BOT_ID, code: `openclaw_${TEST_ACCOUNT_ID}` } });
      await channel.startupAccount(TEST_ACCOUNT_ID);
      vi.clearAllMocks();
    });

    it('should call imbot.v2.Bot.unregister with the bot ID', async () => {
      mockApiResponse('imbot.v2.Bot.unregister', { result: true });

      await channel.logoutAccount(TEST_ACCOUNT_ID);

      const unregisterCall = mockPost.mock.calls.find(
        (call) => call[0] === '/imbot.v2.Bot.unregister',
      );
      expect(unregisterCall).toBeDefined();
      expect(unregisterCall![1].botToken).toBe(TEST_BOT_CLIENT_ID);
      expect(unregisterCall![1].botId).toBe(BOT_ID);

      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('unregistered'),
      );
    });

    it('should not throw if unregister fails (logs warning instead)', async () => {
      mockPost.mockImplementation(() => {
        return Promise.reject(new Error('Bot not found'));
      });

      // Should not throw
      await channel.logoutAccount(TEST_ACCOUNT_ID);

      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to unregister'),
      );
    });

    it('should do nothing if account has no botId', async () => {
      // Create channel without bot registration
      const freshChannel = new Bitrix24Channel();
      freshChannel.configure({
        accounts: [
          {
            id: 'no-bot',
            webhookUrl: TEST_WEBHOOK_URL,
            domain: 'test-portal.bitrix24.ru',
          },
        ],
      });

      vi.clearAllMocks();
      await freshChannel.logoutAccount('no-bot');

      // Should not call any API
      expect(mockPost).not.toHaveBeenCalled();

      freshChannel.destroy();
    });
  });
});
