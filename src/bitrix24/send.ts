import type { Bitrix24Client } from './client.js';
import type { OutgoingMessage } from './types.js';
import { markdownToBBCode, chunkText } from './format.js';
import { sendFile } from './files.js';

// imbot.v2.Chat.Message.send's `fields.message` has a documented hard cap of
// 20,000 chars (spec §4); text beyond that is silently truncated with a
// `" (...)"` suffix appended server-side. We chunk well under that cap (18000,
// leaving headroom) so our own chunking — not Bitrix24's auto-truncation —
// is what splits long messages, avoiding silent data loss.
const DEFAULT_CHUNK_LIMIT = 18000;

/**
 * Send a message from the bot to a Bitrix24 dialog.
 *
 * Flow:
 *   1. Send typing indicator
 *   2. Convert markdown → BB-code
 *   3. Chunk if > textChunkLimit
 *   4. Send each chunk via imbot.v2.Chat.Message.send
 *   5. Send media files via imbot.v2.File.upload (single-call upload+attach+send)
 */
export async function sendMessage(
  client: Bitrix24Client,
  msg: OutgoingMessage,
  opts?: { textChunkLimit?: number },
): Promise<{ messageIds: string[] }> {
  const chunkLimit = opts?.textChunkLimit ?? DEFAULT_CHUNK_LIMIT;
  const messageIds: string[] = [];

  // 1. Typing indicator
  await sendTyping(client, msg.botId, msg.botClientId, msg.dialogId).catch(() => {
    // Non-critical — ignore errors
  });

  // 2. Convert and chunk text
  const bbText = markdownToBBCode(msg.text);
  const chunks = chunkText(bbText, chunkLimit);

  // 3. Send text chunks. Keyboard (if any) is attached to the LAST chunk only
  // — use a numeric loop index rather than `chunks.indexOf(chunk)`, which is
  // both O(n^2) and wrong whenever two chunks happen to be identical strings
  // (indexOf always finds the FIRST match, attaching the keyboard there
  // instead of to the actual last chunk).
  for (let i = 0; i < chunks.length; i++) {
    const id = await sendTextMessage(client, {
      botId: msg.botId,
      botClientId: msg.botClientId,
      dialogId: msg.dialogId,
      text: chunks[i],
      keyboard: i === chunks.length - 1 ? msg.keyboard : undefined,
    });
    messageIds.push(id);
  }

  // 4. Send media files
  if (msg.media && msg.media.length > 0) {
    for (const media of msg.media) {
      await sendFile(client, {
        botId: msg.botId,
        botToken: msg.botClientId,
        dialogId: msg.dialogId,
        fileName: media.fileName,
        fileBuffer: media.buffer,
      });
    }
  }

  return { messageIds };
}

/**
 * Send typing indicator via `imbot.v2.Chat.InputAction.notify`.
 *
 * `statusMessageCode` is left unset, which shows the plain "typing"
 * indicator (spec §6); callers wanting a semantic status (e.g. "thinking")
 * can pass one of the documented codes such as `IMBOT_AGENT_ACTION_THINKING`.
 */
export async function sendTyping(
  client: Bitrix24Client,
  botId: number,
  botToken: string,
  dialogId: string,
): Promise<void> {
  await client.callMethod('imbot.v2.Chat.InputAction.notify', {
    botId,
    botToken,
    dialogId,
  });
}

/**
 * Send a single text message via `imbot.v2.Chat.Message.send`.
 */
async function sendTextMessage(
  client: Bitrix24Client,
  params: {
    botId: number;
    botClientId: string;
    dialogId: string;
    text: string;
    keyboard?: OutgoingMessage['keyboard'];
  },
): Promise<string> {
  const fields: Record<string, any> = {
    message: params.text,
  };

  if (params.keyboard) {
    fields.keyboard = params.keyboard.buttons;
  }

  const result = await client.callMethod<{ id: number | string; uuidMap?: Record<string, unknown> }>(
    'imbot.v2.Chat.Message.send',
    {
      botId: params.botId,
      botToken: params.botClientId,
      dialogId: params.dialogId,
      fields,
    },
  );
  return String(result.id);
}

/**
 * Update an existing bot message via `imbot.v2.Chat.Message.update`.
 */
export async function updateMessage(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
  messageId: string,
  newText: string,
): Promise<void> {
  const bbText = markdownToBBCode(newText);
  await client.callMethod('imbot.v2.Chat.Message.update', {
    botId,
    botToken: botClientId,
    messageId,
    fields: { message: bbText },
  });
}

/**
 * Delete a bot message via `imbot.v2.Chat.Message.delete`.
 */
export async function deleteMessage(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
  messageId: string,
): Promise<void> {
  await client.callMethod('imbot.v2.Chat.Message.delete', {
    botId,
    botToken: botClientId,
    messageId,
  });
}
