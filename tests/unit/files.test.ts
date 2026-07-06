import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bitrix24Client } from '../../src/bitrix24/client.js';
import { sendFile, downloadFile } from '../../src/bitrix24/files.js';

vi.mock('axios', () => {
  const mockPost = vi.fn();
  const mockGet = vi.fn();
  const mockCreate = vi.fn(() => ({ post: mockPost, get: mockGet }));
  return {
    default: {
      create: mockCreate,
      get: mockGet,
    },
    __mockPost: mockPost,
    __mockGet: mockGet,
  };
});

const { __mockPost: mockPost, __mockGet: mockGet } = await import('axios') as any;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeClient(): Bitrix24Client {
  return new Bitrix24Client({
    domain: 'test.bitrix24.ru',
    auth: { type: 'webhook', webhookUrl: 'https://test.bitrix24.ru/rest/1/abc/' },
  });
}

// ── sendFile → imbot.v2.File.upload ─────────────────────────────────────────

describe('sendFile', () => {
  it('calls imbot.v2.File.upload with base64 content (no data-uri prefix)', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        result: {
          file: { id: 138, name: 'report.pdf', extension: 'pdf', size: 35341 },
          messageId: 123,
          chatId: 5,
          dialogId: 'chat5',
        },
      },
    });

    const client = makeClient();
    const fileBuffer = Buffer.from('hello world');
    const result = await sendFile(client, {
      botId: 456,
      botToken: 'bottok',
      dialogId: 'chat5',
      fileName: 'report.pdf',
      fileBuffer,
    });

    expect(mockPost).toHaveBeenCalledWith('/imbot.v2.File.upload', {
      botId: 456,
      botToken: 'bottok',
      dialogId: 'chat5',
      fields: {
        name: 'report.pdf',
        content: fileBuffer.toString('base64'),
      },
    });
    // Never a data: URI prefix on the base64 content.
    const sentFields = mockPost.mock.calls[0][1].fields;
    expect(sentFields.content.startsWith('data:')).toBe(false);

    expect(result).toEqual({
      fileId: 138,
      messageId: '123',
      chatId: '5',
      dialogId: 'chat5',
    });
    client.destroy();
  });

  it('includes an optional caption as fields.message', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        result: {
          file: { id: 1, name: 'a.txt', extension: 'txt', size: 1 },
          messageId: 1,
          chatId: 5,
          dialogId: 'chat5',
        },
      },
    });

    const client = makeClient();
    await sendFile(client, {
      botId: 456,
      botToken: 'bottok',
      dialogId: 'chat5',
      fileName: 'a.txt',
      fileBuffer: Buffer.from('x'),
      message: 'here you go',
    });

    expect(mockPost).toHaveBeenCalledWith('/imbot.v2.File.upload', expect.objectContaining({
      fields: expect.objectContaining({ message: 'here you go' }),
    }));
    client.destroy();
  });
});

// ── downloadFile → imbot.v2.File.download + GET ─────────────────────────────

describe('downloadFile', () => {
  it('resolves a one-time downloadUrl via imbot.v2.File.download, then GETs the bytes', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        result: {
          downloadUrl: 'https://test.bitrix24.ru/rest/download.json?token=imbot%7Cabc',
        },
      },
    });
    mockGet.mockResolvedValueOnce({ data: Buffer.from('file bytes') });

    const client = makeClient();
    const result = await downloadFile(client, {
      botId: 456,
      botToken: 'bottok',
      fileId: 138,
      fileName: 'report.pdf',
    });

    expect(mockPost).toHaveBeenCalledWith('/imbot.v2.File.download', {
      botId: 456,
      botToken: 'bottok',
      fileId: 138,
    });
    expect(mockGet).toHaveBeenCalledWith(
      'https://test.bitrix24.ru/rest/download.json?token=imbot%7Cabc',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
    expect(result.buffer.toString()).toBe('file bytes');
    expect(result.fileName).toBe('report.pdf');
    expect(result.mimeType).toBe('application/pdf');
    client.destroy();
  });

  it('falls back to a generic filename when none is supplied', async () => {
    mockPost.mockResolvedValueOnce({
      data: { result: { downloadUrl: 'https://test.bitrix24.ru/dl?token=x' } },
    });
    mockGet.mockResolvedValueOnce({ data: Buffer.from('bytes') });

    const client = makeClient();
    const result = await downloadFile(client, { botId: 456, botToken: 'bottok', fileId: 42 });

    expect(result.fileName).toBe('file-42');
    expect(result.mimeType).toBe('application/octet-stream');
    client.destroy();
  });
});
