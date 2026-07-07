import type { Bitrix24Client } from './client.js';
import type { MediaAttachment } from './types.js';

/**
 * Send a file to a Bitrix24 chat via `imbot.v2.File.upload`.
 *
 * Single call — combines uploading to Drive, attaching it to the chat, and
 * sending the message (spec §11). Replaces the deprecated two-step
 * `disk.storage.uploadfile` + `im.disk.file.commit` flow used by the v1 API.
 *
 * `fields.content` is raw Base64 with NO data-URI prefix (e.g. no leading
 * "data:mime/type;base64,"). Max 100 MB — larger payloads fail with
 * `FILE_TOO_LARGE`.
 */
export async function sendFile(
  client: Bitrix24Client,
  params: {
    botId: number;
    botToken: string;
    dialogId: string;
    fileName: string;
    fileBuffer: Buffer;
    /** Optional caption sent alongside the file. */
    message?: string;
  },
): Promise<{ fileId: number; messageId: string; chatId: string; dialogId: string }> {
  const fields: Record<string, any> = {
    name: params.fileName,
    content: params.fileBuffer.toString('base64'),
  };
  if (params.message) {
    fields.message = params.message;
  }

  const result = await client.callMethod<{
    file: { id: number; name: string; extension: string; size: number };
    messageId: number | string;
    chatId: number | string;
    dialogId: string;
  }>('imbot.v2.File.upload', {
    botId: params.botId,
    botToken: params.botToken,
    dialogId: params.dialogId,
    fields,
  });

  return {
    fileId: result.file.id,
    messageId: String(result.messageId),
    chatId: String(result.chatId),
    dialogId: result.dialogId,
  };
}

/**
 * Resolve a one-time download link for a known Drive fileId via
 * `imbot.v2.File.download`, then fetch the bytes over HTTP.
 *
 * This replaces `disk.attachedObject.get` / `disk.file.get` — v2 has its own
 * dedicated method that returns a ready-made download URL directly (spec
 * §11). The URL is explicitly one-time ("reuse is not guaranteed"), so it
 * must be consumed immediately.
 *
 * `imbot.v2.File.download` never returns a filename, so pass one via
 * `params.fileName` when known (typically the `FileAttachment.name` captured
 * by the defensive inbound parser in receive.ts — itself best-effort, spec
 * §11 UNVERIFIABLE); falls back to a generic `file-<id>` name otherwise.
 */
export async function downloadFile(
  client: Bitrix24Client,
  params: {
    botId: number;
    botToken: string;
    fileId: number | string;
    fileName?: string;
  },
): Promise<MediaAttachment> {
  const { downloadUrl } = await client.callMethod<{ downloadUrl: string }>(
    'imbot.v2.File.download',
    {
      botId: params.botId,
      botToken: params.botToken,
      fileId: params.fileId,
    },
  );

  const downloaded = await client.downloadFile(downloadUrl);
  // Explicit caller-supplied name wins; otherwise the download response's
  // Content-Disposition is the only real name source (the live FILE_ID
  // inbound shape carries no metadata at all).
  const fileName = params.fileName ?? downloaded.fileName ?? `file-${params.fileId}`;
  const guessed = guessMimeType(fileName);
  // Prefer the extension-based guess when it is specific; fall back to the
  // response Content-Type for extensionless names.
  const mimeType =
    guessed !== 'application/octet-stream'
      ? guessed
      : (downloaded.contentType ?? guessed);

  return { buffer: downloaded.buffer, fileName, mimeType };
}

/**
 * Determine media type category from mime type.
 */
export function mediaKind(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    zip: 'application/zip',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
  };
  return mimeMap[ext ?? ''] ?? 'application/octet-stream';
}
