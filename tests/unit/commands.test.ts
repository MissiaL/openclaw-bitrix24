import { describe, it, expect, vi } from 'vitest';
import { ensureBotCommands, DEFAULT_BOT_COMMANDS } from '../../src/bitrix24/commands.js';

function makeClient(existing: Array<Record<string, unknown>>) {
  return {
    callMethod: vi.fn((method: string) => {
      if (method === 'imbot.v2.Command.list') {
        return Promise.resolve({ commands: existing });
      }
      return Promise.resolve({ command: { id: 100 } });
    }),
  } as any;
}

describe('ensureBotCommands', () => {
  it('registers all defaults on a clean bot', async () => {
    const client = makeClient([
      // Portal built-ins (botId 0, id defN) must be ignored.
      { id: 'def0', botId: 0, command: '/me' },
    ]);
    const result = await ensureBotCommands(client, { botId: 5228, botToken: 'tok' });
    expect(result.registered).toEqual(['status', 'new', 'stop', 'restart', 'openclaw_cb']);
    const registerCalls = client.callMethod.mock.calls.filter(
      (c: any[]) => c[0] === 'imbot.v2.Command.register',
    );
    expect(registerCalls).toHaveLength(5);
    // Live contract: fields.command has no slash, title is a locale map.
    expect(registerCalls[0][1]).toEqual({
      botId: 5228,
      botToken: 'tok',
      fields: { command: 'status', title: DEFAULT_BOT_COMMANDS[0].title },
    });
  });

  it('skips commands the bot already has (list returns them WITH a slash)', async () => {
    const client = makeClient([
      { id: 71, botId: 5228, command: '/status' },
      { id: 72, botId: 5228, command: '/stop' },
    ]);
    const result = await ensureBotCommands(client, { botId: 5228, botToken: 'tok' });
    expect(result.registered).toEqual(['new', 'restart', 'openclaw_cb']);
  });

  it('ignores same-named commands that belong to another bot', async () => {
    const client = makeClient([{ id: 9, botId: 777, command: '/status' }]);
    const result = await ensureBotCommands(client, { botId: 5228, botToken: 'tok' });
    expect(result.registered).toContain('status');
  });
});
