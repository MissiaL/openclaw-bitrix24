import type { KeyboardButton, KeyboardMarkup } from './types.js';

/**
 * Sentinel command name for callback buttons. A COMMAND keyboard button fires
 * an ONIMBOTV2COMMANDADD event on press; we set COMMAND to this sentinel and
 * carry the agent-defined callback value in COMMAND_PARAMS, so the webhook
 * handler can tell a callback press apart from a real slash command and feed
 * the value back to the agent as a plain message.
 */
export const CALLBACK_COMMAND = 'openclaw_cb';

/** Conservative Bitrix keyboard limits (undocumented; kept safe). */
const MAX_LABEL_LENGTH = 60;
const MAX_BUTTONS = 30;

/**
 * Map the host's portable message presentation into a Bitrix keyboard.
 *
 * Reads `presentation.blocks` defensively (the shape comes from openclaw's
 * interactive payload; we must not import openclaw types, so it is treated as
 * `any`). Each `type:"buttons"` block becomes one row, rows are separated by a
 * `{ TYPE:'NEWLINE' }` button. A button with a `url` becomes a LINK button;
 * otherwise its callback value (`action.value` or the legacy `value`) becomes
 * a COMMAND button carrying the value in COMMAND_PARAMS. Buttons without any
 * actionable target are skipped. Returns undefined when there are no buttons.
 */
export function presentationToKeyboard(presentation: unknown): KeyboardMarkup | undefined {
  const blocks = (presentation as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks)) return undefined;

  const rows: KeyboardButton[][] = [];
  for (const block of blocks) {
    if (!block || (block as { type?: unknown }).type !== 'buttons') continue;
    const buttons = (block as { buttons?: unknown }).buttons;
    if (!Array.isArray(buttons)) continue;

    const row: KeyboardButton[] = [];
    for (const raw of buttons) {
      const btn = toKeyboardButton(raw);
      if (btn) row.push(btn);
    }
    if (row.length > 0) rows.push(row);
  }

  if (rows.length === 0) return undefined;

  // Flatten rows into Bitrix's single BUTTONS array, inserting a NEWLINE
  // separator between rows (not after the last one).
  const flat: KeyboardButton[] = [];
  rows.forEach((row, i) => {
    if (i > 0) flat.push({ TYPE: 'NEWLINE' });
    flat.push(...row);
  });

  return { BUTTONS: flat.slice(0, MAX_BUTTONS) };
}

function toKeyboardButton(raw: unknown): KeyboardButton | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as {
    label?: unknown;
    url?: unknown;
    value?: unknown;
    action?: { type?: unknown; value?: unknown } | null;
  };
  const label = typeof b.label === 'string' ? b.label.slice(0, MAX_LABEL_LENGTH) : '';
  if (label === '') return undefined;

  const url = typeof b.url === 'string' && b.url !== '' ? b.url : undefined;
  if (url) {
    return { TEXT: label, LINK: url, DISPLAY: 'LINE' };
  }

  const callback =
    typeof b.action?.value === 'string' && b.action.value !== ''
      ? b.action.value
      : typeof b.value === 'string' && b.value !== ''
        ? b.value
        : undefined;
  if (callback !== undefined) {
    return {
      TEXT: label,
      COMMAND: CALLBACK_COMMAND,
      COMMAND_PARAMS: callback,
      DISPLAY: 'LINE',
    };
  }

  // No actionable target — skip (a bare text button does nothing in Bitrix).
  return undefined;
}
