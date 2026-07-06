import { describe, it, expect, vi } from 'vitest';
import { updateBotEventUrls } from '../../src/bitrix24/bot.js';

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
