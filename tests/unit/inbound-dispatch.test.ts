import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wireInboundDispatch } from '../../extensions/bitrix24/src/inbound-dispatch.js';
import type { IncomingMessage } from '../../src/bitrix24/types.js';

const ACCOUNT_ID = 'acct-1';

function makeIncomingMessage(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: 100,
    dialogId: 'chat42',
    text: '[b]hi[/b]',
    fromUserId: 7,
    fromUserName: 'Ivan',
    fromUserLastName: 'Petrov',
    isBot: false,
    chatType: 'P',
    files: [],
    domain: 'test-portal.bitrix24.ru',
    botId: 1,
    botCode: 'openclaw_acct-1',
    ...overrides,
  };
}

function makeFakeChannel() {
  let callback: ((accountId: string, msg: IncomingMessage) => void | Promise<void>) | null = null;
  return {
    onMessage: vi.fn((cb: (accountId: string, msg: IncomingMessage) => void | Promise<void>) => {
      callback = cb;
    }),
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
    // Test helper, not part of the real Bitrix24Channel surface.
    trigger: async (accountId: string, msg: IncomingMessage) => {
      await callback?.(accountId, msg);
    },
  };
}

function makeFakeApi(overrides: Record<string, any> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {},
    runtime: {},
    ...overrides,
  };
}

describe('wireInboundDispatch', () => {
  let channel: ReturnType<typeof makeFakeChannel>;

  beforeEach(() => {
    channel = makeFakeChannel();
  });

  it('registers a callback via channel.onMessage', () => {
    const api = makeFakeApi();
    wireInboundDispatch(api as any, channel as any);
    expect(channel.onMessage).toHaveBeenCalledOnce();
  });

  it('dispatches to runtime.channel.inbound.dispatchReply with BB->MD converted Body, correct channel/accountId, and a stable SessionKey', async () => {
    const dispatchReply = vi.fn().mockResolvedValue(undefined);
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: {
            // Identity passthrough — asserts the raw fields we build, since
            // the real finalizeInboundContext shape is a LIVE-TUNE unknown.
            finalizeInboundContext: (ctx: any) => ctx,
          },
        },
      },
    });

    wireInboundDispatch(api as any, channel as any);
    const msg = makeIncomingMessage({ text: '[b]hi[/b]', dialogId: 'chat42' });
    await channel.trigger(ACCOUNT_ID, msg);

    expect(dispatchReply).toHaveBeenCalledOnce();
    const args = dispatchReply.mock.calls[0][0];
    expect(args.channel).toBe('bitrix24');
    expect(args.accountId).toBe(ACCOUNT_ID);
    expect(args.ctxPayload.Body).toContain('**hi**');
    expect(args.ctxPayload.SessionKey).toBe(`bitrix24:${ACCOUNT_ID}:chat42`);
    expect(args.routeSessionKey).toBe(`bitrix24:${ACCOUNT_ID}:chat42`);
  });

  it('delivery.deliver sends payload.text back to the dialog via channel.sendTextMessage', async () => {
    let capturedDelivery: any;
    const dispatchReply = vi.fn().mockImplementation(async (args: any) => {
      capturedDelivery = args.delivery;
    });
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: { finalizeInboundContext: (ctx: any) => ctx },
        },
      },
    });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ dialogId: 'chat99' }));

    expect(capturedDelivery).toBeDefined();
    await capturedDelivery.deliver({ text: 'hi' });

    expect(channel.sendTextMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'chat99', 'hi');
  });

  it('delivery.deliver falls back to payload.body when payload.text is absent', async () => {
    let capturedDelivery: any;
    const dispatchReply = vi.fn().mockImplementation(async (args: any) => {
      capturedDelivery = args.delivery;
    });
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: { finalizeInboundContext: (ctx: any) => ctx },
        },
      },
    });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ dialogId: 'chat99' }));

    await capturedDelivery.deliver({ body: 'from body field' });

    expect(channel.sendTextMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'chat99', 'from body field');
  });

  it('delivery.deliver does not call sendTextMessage when payload has neither text nor body', async () => {
    let capturedDelivery: any;
    const dispatchReply = vi.fn().mockImplementation(async (args: any) => {
      capturedDelivery = args.delivery;
    });
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: { finalizeInboundContext: (ctx: any) => ctx },
        },
      },
    });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage());

    await capturedDelivery.deliver({ someOtherField: 1 });

    expect(channel.sendTextMessage).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it('delivery.deliver catches a sendTextMessage failure without throwing', async () => {
    let capturedDelivery: any;
    const dispatchReply = vi.fn().mockImplementation(async (args: any) => {
      capturedDelivery = args.delivery;
    });
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: { finalizeInboundContext: (ctx: any) => ctx },
        },
      },
    });
    channel.sendTextMessage.mockRejectedValueOnce(new Error('boom'));

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage());

    await expect(capturedDelivery.deliver({ text: 'hi' })).resolves.toBeUndefined();
    expect(api.logger.error).toHaveBeenCalled();
  });

  it('logs a warning and does not throw when dispatchReply is unavailable', async () => {
    const api = makeFakeApi({ runtime: { channel: {} } });

    wireInboundDispatch(api as any, channel as any);

    await expect(channel.trigger(ACCOUNT_ID, makeIncomingMessage())).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it('logs a warning and does not throw when runtime.channel is entirely absent', async () => {
    const api = makeFakeApi({ runtime: {} });

    wireInboundDispatch(api as any, channel as any);

    await expect(channel.trigger(ACCOUNT_ID, makeIncomingMessage())).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it('never throws even when dispatchReply itself rejects', async () => {
    const dispatchReply = vi.fn().mockRejectedValue(new Error('host blew up'));
    const api = makeFakeApi({
      runtime: {
        channel: {
          inbound: { dispatchReply },
          reply: { finalizeInboundContext: (ctx: any) => ctx },
        },
      },
    });

    wireInboundDispatch(api as any, channel as any);

    await expect(channel.trigger(ACCOUNT_ID, makeIncomingMessage())).resolves.toBeUndefined();
    expect(api.logger.error).toHaveBeenCalled();
  });
});
