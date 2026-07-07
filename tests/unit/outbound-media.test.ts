import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOutboundMedia } from '../../extensions/bitrix24/src/outbound-media.js';

describe('loadOutboundMedia', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a local path via the host-supplied mediaReadFile (sandbox reader)', async () => {
    const reader = vi.fn().mockResolvedValue(Buffer.from('agent file'));
    const media = await loadOutboundMedia('/agent/out/report.txt', reader);
    expect(reader).toHaveBeenCalledWith('/agent/out/report.txt');
    expect(media.fileName).toBe('report.txt');
    expect(media.buffer.toString()).toBe('agent file');
  });

  it('strips a file:// prefix before reading', async () => {
    const reader = vi.fn().mockResolvedValue(Buffer.from('x'));
    await loadOutboundMedia('file:///agent/out/kp.docx', reader);
    expect(reader).toHaveBeenCalledWith('/agent/out/kp.docx');
  });

  it('falls back to plain fs when no reader is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b24-test-'));
    const p = join(dir, 'из-фс.txt');
    await writeFile(p, 'fs bytes');
    try {
      const media = await loadOutboundMedia(p);
      expect(media.buffer.toString()).toBe('fs bytes');
      expect(media.fileName).toBe('из-фс.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fetches an http URL and recovers filename/type from headers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('web bytes').buffer,
      headers: new Headers({
        'content-type': 'application/pdf; charset=binary',
        'content-disposition': `attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf`,
      }),
    }));
    const media = await loadOutboundMedia('https://example.com/dl?id=1');
    expect(media.fileName).toBe('Отчёт.pdf');
    expect(media.mimeType).toBe('application/pdf');
    expect(media.buffer.toString()).toBe('web bytes');
  });

  it('derives the filename from the URL path when headers are silent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers(),
    }));
    const media = await loadOutboundMedia('https://example.com/files/summary.xlsx');
    expect(media.fileName).toBe('summary.xlsx');
  });

  it('throws on a non-OK http response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() }));
    await expect(loadOutboundMedia('https://example.com/gone.pdf')).rejects.toThrow('HTTP 404');
  });
});
