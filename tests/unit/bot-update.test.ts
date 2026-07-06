import { describe, it, expect, vi } from 'vitest';
import { updateBotEventUrls } from '../../src/bitrix24/bot.js';

describe('updateBotEventUrls', () => {
  it('sends imbot.update with all three event URLs', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue(true) } as any;
    await updateBotEventUrls(client, {
      botId: 42,
      botClientId: 'secret-client-id',
      accountId: 'default',
      webhookBaseUrl: 'https://new.example/',
    });
    expect(client.callMethod).toHaveBeenCalledWith('imbot.update', {
      CLIENT_ID: 'secret-client-id',
      BOT_ID: 42,
      FIELDS: {
        EVENT_MESSAGE_ADD: 'https://new.example/webhook/bitrix24/default/message',
        EVENT_WELCOME_MESSAGE: 'https://new.example/webhook/bitrix24/default/welcome',
        EVENT_BOT_DELETE: 'https://new.example/webhook/bitrix24/default/delete',
      },
    });
  });
});
