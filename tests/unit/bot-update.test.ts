import { describe, it, expect, vi } from 'vitest';
import { updateBotEventUrls, ensureWebhookMode } from '../../src/bitrix24/bot.js';

describe('updateBotEventUrls', () => {
  it('sends imbot.v2.Bot.update with a single webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 42 } }) } as any;
    await updateBotEventUrls(client, {
      botId: 42,
      botClientId: 'secret-client-id',
      accountId: 'default',
      webhookBaseUrl: 'https://new.example/',
    });
    expect(client.callMethod).toHaveBeenCalledWith('imbot.v2.Bot.update', {
      botId: 42,
      botToken: 'secret-client-id',
      fields: { webhookUrl: 'https://new.example/webhook/bitrix24/default' },
    });
  });

  it('strips a trailing slash from the base URL before building webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 7 } }) } as any;
    await updateBotEventUrls(client, {
      botId: 7,
      botClientId: 'tok',
      accountId: 'acct-2',
      webhookBaseUrl: 'https://no-trailing-slash.example',
    });
    expect(client.callMethod).toHaveBeenCalledWith('imbot.v2.Bot.update', {
      botId: 7,
      botToken: 'tok',
      fields: { webhookUrl: 'https://no-trailing-slash.example/webhook/bitrix24/acct-2' },
    });
  });
});

describe('ensureWebhookMode', () => {
  it('sends imbot.v2.Bot.update with eventMode:webhook and the single webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 42, eventMode: 'webhook' } }) } as any;
    await ensureWebhookMode(client, {
      botId: 42,
      botClientId: 'secret-client-id',
      accountId: 'default',
      webhookBaseUrl: 'https://agent.example.com',
    });

    expect(client.callMethod).toHaveBeenCalledWith('imbot.v2.Bot.update', {
      botId: 42,
      botToken: 'secret-client-id',
      fields: {
        eventMode: 'webhook',
        webhookUrl: 'https://agent.example.com/webhook/bitrix24/default',
      },
    });
  });

  it('strips a trailing slash from the base URL before building webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 7 } }) } as any;
    await ensureWebhookMode(client, {
      botId: 7,
      botClientId: 'tok',
      accountId: 'acct-2',
      webhookBaseUrl: 'https://no-trailing-slash.example',
    });
    expect(client.callMethod).toHaveBeenCalledWith('imbot.v2.Bot.update', {
      botId: 7,
      botToken: 'tok',
      fields: {
        eventMode: 'webhook',
        webhookUrl: 'https://no-trailing-slash.example/webhook/bitrix24/acct-2',
      },
    });
  });

  it('propagates a BOT_OWNERSHIP_ERROR thrown by the underlying API call (caller must catch)', async () => {
    const ownershipError = new Error('Bitrix24 API error [imbot.v2.Bot.update]: BOT_OWNERSHIP_ERROR — bot is owned by a different token');
    const client = { callMethod: vi.fn().mockRejectedValue(ownershipError) } as any;

    await expect(
      ensureWebhookMode(client, {
        botId: 42,
        botClientId: 'wrong-token',
        accountId: 'default',
        webhookBaseUrl: 'https://agent.example.com',
      }),
    ).rejects.toThrow('BOT_OWNERSHIP_ERROR');
  });
});
