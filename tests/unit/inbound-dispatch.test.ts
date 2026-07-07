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
    trigger: async (accountId: string, msg: IncomingMessage) => {
      await callback?.(accountId, msg);
    },
  };
}

/**
 * Build a fake runtime.channel mirroring the feishu/googlechat inbound API:
 * routing.resolveAgentRoute + inbound.run(adapter). `run` invokes the adapter's
 * resolveTurn and exposes the resolved turn (incl. delivery) for assertions.
 */
function makeRuntime() {
  const run = vi.fn(async (params: any) => {
    const turn = params.adapter.resolveTurn();
    (run as any).lastTurn = turn;
    (run as any).lastRunParams = params;
  });
  const resolveAgentRoute = vi.fn(() => ({
    agentId: 'main',
    sessionKey: 'agent:main:bitrix24:acct-1:chat42',
    accountId: ACCOUNT_ID,
    matchedBy: 'default',
  }));
  return {
    runtime: {
      channel: {
        routing: { resolveAgentRoute },
        inbound: { run },
        reply: { finalizeInboundContext: (ctx: any) => ({ ...ctx, finalized: true }) },
        session: { resolveStorePath: () => '/store/sessions.json', recordInboundSession: vi.fn() },
      },
    },
    run,
    resolveAgentRoute,
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

  it('resolves the agent route and runs inbound.run with a BB->MD Body and the resolved session/agent', async () => {
    const { runtime, run, resolveAgentRoute } = makeRuntime();
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ text: '[b]hi[/b]', dialogId: 'chat42' }));

    expect(resolveAgentRoute).toHaveBeenCalledOnce();
    const routeArgs = resolveAgentRoute.mock.calls[0][0];
    expect(routeArgs.channel).toBe('bitrix24');
    expect(routeArgs.accountId).toBe(ACCOUNT_ID);
    expect(routeArgs.peer).toEqual({ kind: 'direct', id: 'chat42' });

    expect(run).toHaveBeenCalledOnce();
    const turn = (run as any).lastTurn;
    expect(turn.channel).toBe('bitrix24');
    expect(turn.accountId).toBe(ACCOUNT_ID);
    expect(turn.agentId).toBe('main');
    expect(turn.routeSessionKey).toBe('agent:main:bitrix24:acct-1:chat42');
    expect(turn.ctxPayload.Body).toContain('**hi**');
    expect(turn.ctxPayload.finalized).toBe(true);
    expect(turn.ctxPayload.MessageSid).toBe('100');
  });

  it('delivery.deliver sends the final reply text back to the dialog via sendTextMessage', async () => {
    const { runtime, run } = makeRuntime();
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ dialogId: 'chat99' }));

    const delivery = (run as any).lastTurn.delivery;
    await delivery.deliver({ text: 'hi' }, { kind: 'final' });

    expect(channel.sendTextMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'chat99', 'hi');
  });

  it('delivery.deliver skips intermediate (non-final) blocks', async () => {
    const { runtime, run } = makeRuntime();
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ dialogId: 'chat99' }));

    const delivery = (run as any).lastTurn.delivery;
    await delivery.deliver({ text: 'partial' }, { kind: 'block' });

    expect(channel.sendTextMessage).not.toHaveBeenCalled();
  });

  it('delivery.deliver falls back to payload.body when text is absent', async () => {
    const { runtime, run } = makeRuntime();
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage({ dialogId: 'chat99' }));

    const delivery = (run as any).lastTurn.delivery;
    await delivery.deliver({ body: 'from body field' }, { kind: 'final' });

    expect(channel.sendTextMessage).toHaveBeenCalledWith(ACCOUNT_ID, 'chat99', 'from body field');
  });

  it('delivery.deliver does not send when the final payload has neither text nor body', async () => {
    const { runtime, run } = makeRuntime();
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage());

    const delivery = (run as any).lastTurn.delivery;
    await delivery.deliver({ someOtherField: 1 }, { kind: 'final' });

    expect(channel.sendTextMessage).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it('delivery.deliver catches a sendTextMessage failure without throwing', async () => {
    const { runtime, run } = makeRuntime();
    const api = makeFakeApi({ runtime });
    channel.sendTextMessage.mockRejectedValueOnce(new Error('boom'));

    wireInboundDispatch(api as any, channel as any);
    await channel.trigger(ACCOUNT_ID, makeIncomingMessage());

    const delivery = (run as any).lastTurn.delivery;
    await expect(delivery.deliver({ text: 'hi' }, { kind: 'final' })).resolves.toBeUndefined();
    expect(api.logger.error).toHaveBeenCalled();
  });

  it('logs a warning and does not throw when inbound.run / routing are unavailable', async () => {
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

  it('never throws even when inbound.run itself rejects', async () => {
    const { runtime, run } = makeRuntime();
    run.mockRejectedValueOnce(new Error('host blew up'));
    const api = makeFakeApi({ runtime });

    wireInboundDispatch(api as any, channel as any);

    await expect(channel.trigger(ACCOUNT_ID, makeIncomingMessage())).resolves.toBeUndefined();
    expect(api.logger.error).toHaveBeenCalled();
  });
});
