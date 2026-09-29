import { describe, it, expect, vi } from 'vitest';
import { registerBot } from '../../src/bitrix24/bot.js';
import type { BotConfig } from '../../src/bitrix24/types.js';

describe('registerBot', () => {
  it('registers via imbot.v2.Bot.register with a single webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 456, code: 'openclaw_default' } }) } as any;
    const res = await registerBot(client, 'default', 'https://x.example', {
      name: 'OpenClaw Agent', clientId: 'tok', color: 'PURPLE', workPosition: 'AI Assistant',
    } as BotConfig);

    expect(client.callMethod).toHaveBeenCalledWith('imbot.v2.Bot.register', {
      fields: {
        code: 'openclaw_default',
        botToken: 'tok',
        eventMode: 'webhook',
        webhookUrl: 'https://x.example/webhook/bitrix24/default',
        type: 'bot',
        properties: { name: 'OpenClaw Agent', lastName: '', color: 'PURPLE', workPosition: 'AI Assistant' },
      },
    });
    expect(res).toEqual({ botId: 456, botCode: 'openclaw_default' });
  });

  it('strips a trailing slash from the base URL before building webhookUrl', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 1, code: 'openclaw_a' } }) } as any;
    await registerBot(client, 'a', 'https://x.example/', {
      name: 'Bot', clientId: 'tok',
    } as BotConfig);

    const payload = client.callMethod.mock.calls[0][1];
    expect(payload.fields.webhookUrl).toBe('https://x.example/webhook/bitrix24/a');
  });

  it('includes avatar in properties only when present', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 1, code: 'openclaw_a' } }) } as any;
    await registerBot(client, 'a', 'https://x.example', {
      name: 'Bot', clientId: 'tok', avatar: 'aGVsbG8=',
    } as BotConfig);

    const payload = client.callMethod.mock.calls[0][1];
    expect(payload.fields.properties.avatar).toBe('aGVsbG8=');
  });

  it('omits avatar entirely when not configured', async () => {
    const client = { callMethod: vi.fn().mockResolvedValue({ bot: { id: 1, code: 'openclaw_a' } }) } as any;
    await registerBot(client, 'a', 'https://x.example', {
      name: 'Bot', clientId: 'tok',
    } as BotConfig);

    const payload = client.callMethod.mock.calls[0][1];
    expect(payload.fields.properties).not.toHaveProperty('avatar');
  });

  it('throws when config.clientId (botToken) is missing', async () => {
    const client = { callMethod: vi.fn() } as any;
    await expect(
      registerBot(client, 'default', 'https://x.example', { name: 'Bot' } as BotConfig),
    ).rejects.toThrow(/botToken/);
    expect(client.callMethod).not.toHaveBeenCalled();
  });
});
