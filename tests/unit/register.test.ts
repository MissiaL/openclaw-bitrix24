import { describe, it, expect, vi } from 'vitest';

vi.mock('axios', () => {
  const mockPost = vi.fn().mockResolvedValue({
    data: { result: { scope: ['imbot', 'im', 'disk'], license: 'pro' } },
  });
  const mockCreate = vi.fn(() => ({ post: mockPost }));
  return {
    default: { create: mockCreate },
    __mockPost: mockPost,
  };
});

import register from '../../extensions/bitrix24/src/index.js';
import { Bitrix24Channel } from '../../extensions/bitrix24/src/channel.js';

function makeFakeApi(overrides: Record<string, any> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {},
    registerChannel: vi.fn(),
    registerService: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerCommand: vi.fn(),
    runtime: { config: { mutateConfigFile: vi.fn().mockResolvedValue(undefined) } },
    ...overrides,
  };
}

describe('plugin register(api)', () => {
  it('registers webhook prefix route with plugin auth', () => {
    const api = makeFakeApi();
    register(api);
    expect(api.registerHttpRoute).toHaveBeenCalledOnce();
    const params = api.registerHttpRoute.mock.calls[0][0];
    expect(params.path).toBe('/webhook/bitrix24/');
    expect(params.match).toBe('prefix');
    expect(params.auth).toBe('plugin');
    expect(typeof params.handler).toBe('function');

    // Both registrations must happen in the same run: modern hosts use the
    // HTTP route above, but registerService.router is still wired for older
    // hosts that ignore registerHttpRoute.
    expect(api.registerService).toHaveBeenCalledOnce();
    const service = api.registerService.mock.calls[0][0];
    expect(service.id).toBe('bitrix24-webhook');
    expect(service.router).toBeDefined();
  });

  it('keeps legacy service router for older hosts', () => {
    const api = makeFakeApi({ registerHttpRoute: undefined });
    expect(() => register(api)).not.toThrow();
    const service = api.registerService.mock.calls[0][0];
    expect(service.id).toBe('bitrix24-webhook');
    expect(service.router).toBeDefined();
  });

  it('declares complete channel meta (docsPath, blurb, labels)', () => {
    const api = makeFakeApi();
    register(api);
    const meta = api.registerChannel.mock.calls[0][0].plugin.meta;
    expect(meta.docsPath).toBe('/channels/bitrix24');
    expect(meta.label).toBeTruthy();
    expect(meta.selectionLabel).toBeTruthy();
    expect(meta.blurb).toBeTruthy();
  });

  it('/b24setup persists the webhook URL via mutateConfigFile (not the phantom api.persistConfig)', async () => {
    const api = makeFakeApi();
    register(api);

    const setupCommand = api.registerCommand.mock.calls.find(
      (call: any[]) => call[0].name === 'b24setup',
    )[0];
    const webhookUrl = 'https://example.bitrix24.ru/rest/1/testsecret/';

    await setupCommand.handler({ args: webhookUrl });

    expect(api.runtime.config.mutateConfigFile).toHaveBeenCalled();
    const params = api.runtime.config.mutateConfigFile.mock.calls[0][0];
    const draft: any = {};
    params.mutate(draft);
    expect(draft.channels.bitrix24.webhookUrl).toBe(webhookUrl);
  });

  // The host calls outbound.sendText with a ChannelOutboundContext:
  // `{ cfg, to, text, accountId, ... }` — there is NO `dialogId` field. This is
  // the path the agent's `message` tool uses; a wrong destructure means every
  // tool-driven send fails with an undefined dialog (observed live: the agent
  // then invents REST workarounds instead of replying).
  describe('outbound.sendText (ChannelOutboundContext contract)', () => {
    function registerAndGetSendText() {
      const api = makeFakeApi();
      register(api);
      return api.registerChannel.mock.calls[0][0].plugin.outbound.sendText;
    }

    it('sends to the `to` target and returns an OutboundDeliveryResult', async () => {
      const spy = vi
        .spyOn(Bitrix24Channel.prototype, 'sendTextMessage')
        .mockResolvedValue({ messageIds: ['777'] } as any);
      try {
        const sendText = registerAndGetSendText();
        const result = await sendText({
          cfg: {},
          to: '2172',
          text: 'hello',
          accountId: 'default',
        });
        expect(spy).toHaveBeenCalledWith('default', '2172', 'hello', undefined);
        expect(result.channel).toBe('bitrix24');
        expect(result.messageId).toBe('777');
      } finally {
        spy.mockRestore();
      }
    });

    it('strips a channel-prefixed target (bitrix24:2172 → 2172)', async () => {
      const spy = vi
        .spyOn(Bitrix24Channel.prototype, 'sendTextMessage')
        .mockResolvedValue({ messageIds: ['1'] } as any);
      try {
        const sendText = registerAndGetSendText();
        await sendText({ cfg: {}, to: 'bitrix24:2172', text: 'hi', accountId: 'default' });
        expect(spy).toHaveBeenCalledWith('default', '2172', 'hi', undefined);
      } finally {
        spy.mockRestore();
      }
    });

    // Bitrix dialog ids are short numerics ("2172") or "chatNN" — both fail the
    // host's generic id heuristic (/^\+?\d{6,}$/), so without a plugin
    // targetResolver every message-tool send dies with `Unknown target "2172"
    // for Bitrix24.` (observed live, recorded in the portal's .learnings).
    it('registers a targetResolver that recognizes Bitrix dialog ids', async () => {
      const api = makeFakeApi();
      register(api);
      const messaging = api.registerChannel.mock.calls[0][0].plugin.messaging;
      expect(messaging?.targetResolver?.looksLikeId).toBeTypeOf('function');
      const { looksLikeId, resolveTarget } = messaging.targetResolver;
      expect(looksLikeId('2172')).toBe(true);
      expect(looksLikeId('chat15762')).toBe(true);
      expect(looksLikeId('bitrix24:2172')).toBe(true);
      expect(looksLikeId('Иван Петров')).toBe(false);
      await expect(
        resolveTarget({ cfg: {}, input: 'bitrix24:2172', normalized: 'bitrix24:2172' }),
      ).resolves.toEqual({ to: '2172', kind: 'user' });
      await expect(
        resolveTarget({ cfg: {}, input: 'chat15762', normalized: 'chat15762' }),
      ).resolves.toMatchObject({ to: 'chat15762', kind: 'group' });
      await expect(
        resolveTarget({ cfg: {}, input: 'not-a-dialog', normalized: 'not-a-dialog' }),
      ).resolves.toBeNull();
    });

    it('falls back to the default account when accountId is absent', async () => {
      const spy = vi
        .spyOn(Bitrix24Channel.prototype, 'sendTextMessage')
        .mockResolvedValue({ messageIds: ['1'] } as any);
      const defaultSpy = vi
        .spyOn(Bitrix24Channel.prototype, 'resolveDefaultAccountId')
        .mockReturnValue('default');
      try {
        const sendText = registerAndGetSendText();
        await sendText({ cfg: {}, to: '2172', text: 'hi' });
        expect(spy).toHaveBeenCalledWith('default', '2172', 'hi', undefined);
      } finally {
        spy.mockRestore();
        defaultSpy.mockRestore();
      }
    });
  });
});
