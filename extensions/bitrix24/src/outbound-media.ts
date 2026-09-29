import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileNameFromDisposition } from '../../../src/bitrix24/client.js';

/**
 * Resolve the host's outbound `mediaUrl` into a Bitrix upload attachment.
 *
 * The host hands channels one of:
 *   - a local filesystem path (agent-generated files), optionally `file://`-
 *     prefixed — read via the host-supplied `mediaReadFile` when present
 *     (it enforces the host's local-root sandbox), else plain fs;
 *   - an `http(s)` URL — fetched, with the filename recovered from
 *     Content-Disposition (RFC 5987 `filename*` preferred) or the URL path.
 *
 * `mimeType` is advisory only (imbot.v2.File.upload infers the type from the
 * file name), so a generic fallback is fine.
 */
export async function loadOutboundMedia(
  mediaUrl: string,
  mediaReadFile?: (filePath: string) => Promise<Buffer>,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  if (/^https?:\/\//i.test(mediaUrl)) {
    const res = await fetch(mediaUrl);
    if (!res.ok) {
      throw new Error(`outbound media fetch failed: HTTP ${res.status} for ${mediaUrl}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const fileName =
      fileNameFromDisposition(res.headers.get('content-disposition')) ||
      basename(new URL(mediaUrl).pathname) ||
      'file';
    const mimeType =
      res.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    return { buffer, fileName, mimeType };
  }

  const filePath = mediaUrl.replace(/^file:\/\//i, '');
  const buffer = mediaReadFile ? await mediaReadFile(filePath) : await readFile(filePath);
  return {
    buffer,
    fileName: basename(filePath) || 'file',
    mimeType: 'application/octet-stream',
  };
}
