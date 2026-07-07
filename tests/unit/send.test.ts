import { describe, it, expect, vi } from 'vitest';
import { sendMessage } from '../../src/bitrix24/send.js';
import type { OutgoingMessage } from '../../src/bitrix24/types.js';

/**
 * Fake client whose `callMethod` resolves directly to the (already-unwrapped)
 * result object, matching `Bitrix24Client.callMethod`'s real contract.
 * `imbot.v2.Chat.Message.send` responses are handed out from `sendResults` in
 * call order; every other method (typing indicator, etc.) resolves to a
 * harmless placeholder.
 */
function makeClient(sendResults: Array<{ id: number }>) {
  let call = 0;
  return {
    callMethod: vi.fn((method: string) => {
      if (method === 'imbot.v2.Chat.Message.send') {
        const result = sendResults[call] ?? { id: 1000 + call };
        call++;
        return Promise.resolve(result);
      }
      return Promise.resolve({ result: true });
    }),
  } as any;
}

function messageSendCalls(client: ReturnType<typeof makeClient>) {
  return client.callMethod.mock.calls.filter(
    (c: any[]) => c[0] === 'imbot.v2.Chat.Message.send',
  );
}

describe('sendMessage — chunking + keyboard attachment (minor fix a)', () => {
  it('attaches the keyboard only to the LAST chunk, even when two chunks are identical strings', async () => {
    // Regression test: the old code used `chunks.indexOf(chunk)` to find the
    // "last chunk" position, which returns the FIRST matching index for a
    // duplicate string — so the keyboard would have landed on chunk 0, not
    // chunk 1, whenever two chunks were textually identical.
    const client = makeClient([{ id: 1 }, { id: 2 }]);
    const keyboard = { BUTTONS: [{ TEXT: 'OK', COMMAND: 'openclaw_cb', COMMAND_PARAMS: 'ok' }] };

    // chunkText('aaaa\n\naaaa', 4) === ['aaaa', 'aaaa'] — two identical chunks.
    const msg: OutgoingMessage = {
      botId: 42,
      botClientId: 'tok',
      dialogId: '5',
      text: 'aaaa\n\naaaa',
      keyboard,
    };

    await sendMessage(client, msg, { textChunkLimit: 4 });

    const sendCalls = messageSendCalls(client);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0][1].fields.message).toBe('aaaa');
    expect(sendCalls[0][1].fields.keyboard).toBeUndefined();
    expect(sendCalls[1][1].fields.message).toBe('aaaa');
    expect(sendCalls[1][1].fields.keyboard).toEqual(keyboard);
  });

  it('omits the keyboard from every chunk when no keyboard is provided', async () => {
    const client = makeClient([{ id: 1 }, { id: 2 }]);
    const msg: OutgoingMessage = {
      botId: 42,
      botClientId: 'tok',
      dialogId: '5',
      text: 'aaaa\n\naaaa',
    };

    await sendMessage(client, msg, { textChunkLimit: 4 });

    const sendCalls = messageSendCalls(client);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls.every((c: any[]) => c[1].fields.keyboard === undefined)).toBe(true);
  });

  it('attaches the keyboard to the single chunk when the text does not need chunking', async () => {
    const client = makeClient([{ id: 1 }]);
    const keyboard = { BUTTONS: [{ TEXT: 'OK', COMMAND: 'openclaw_cb', COMMAND_PARAMS: 'ok' }] };
    const msg: OutgoingMessage = {
      botId: 42,
      botClientId: 'tok',
      dialogId: '5',
      text: 'short',
      keyboard,
    };

    await sendMessage(client, msg);

    const sendCalls = messageSendCalls(client);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0][1].fields.keyboard).toEqual(keyboard);
  });

  it('attaches the keyboard to the last of three+ chunks', async () => {
    const client = makeClient([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const keyboard = { BUTTONS: [{ TEXT: 'Next', COMMAND: 'openclaw_cb', COMMAND_PARAMS: 'next' }] };
    // 'aa\n\naa\n\naa' with maxLength=2 splits into three chunks: ['aa','aa','aa'].
    const msg: OutgoingMessage = {
      botId: 42,
      botClientId: 'tok',
      dialogId: '5',
      text: 'aa\n\naa\n\naa',
      keyboard,
    };

    await sendMessage(client, msg, { textChunkLimit: 2 });

    const sendCalls = messageSendCalls(client);
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    const last = sendCalls[sendCalls.length - 1];
    expect(last[1].fields.keyboard).toEqual(keyboard);
    for (const call of sendCalls.slice(0, -1)) {
      expect(call[1].fields.keyboard).toBeUndefined();
    }
  });
});

// ── File-only sends (agent-generated outbound files) ─────────────────────────

function makeMediaClient() {
  return {
    callMethod: vi.fn((method: string) => {
      if (method === 'imbot.v2.Chat.Message.send') {
        return Promise.resolve({ id: 501 });
      }
      if (method === 'imbot.v2.File.upload') {
        return Promise.resolve({
          file: { id: 9001, name: 'report.txt', extension: 'txt', size: 11 },
          messageId: 777,
          chatId: 15762,
          dialogId: '2172',
        });
      }
      return Promise.resolve({ result: true });
    }),
  } as any;
}

describe('sendMessage — media sends', () => {
  const media = [{ buffer: Buffer.from('88002000000'), fileName: 'report.txt', mimeType: 'text/plain' }];
  const base: OutgoingMessage = {
    botId: 1,
    botClientId: 'tok',
    dialogId: '2172',
    text: '',
    media,
  };

  it('does NOT send an empty text chunk for a file-only message', async () => {
    const client = makeMediaClient();
    await sendMessage(client, { ...base, text: '' });
    expect(messageSendCalls(client)).toHaveLength(0);
    const uploads = client.callMethod.mock.calls.filter((c: any[]) => c[0] === 'imbot.v2.File.upload');
    expect(uploads).toHaveLength(1);
  });

  it('collects file message ids into messageIds (quote cache needs them)', async () => {
    const client = makeMediaClient();
    const result = await sendMessage(client, { ...base, text: '' });
    expect(result.messageIds).toEqual(['777']);
  });

  it('sends text chunk AND file when both are present', async () => {
    const client = makeMediaClient();
    const result = await sendMessage(client, { ...base, text: 'вот файл' });
    expect(messageSendCalls(client)).toHaveLength(1);
    expect(result.messageIds).toEqual(['501', '777']);
  });
});
