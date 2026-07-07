import { describe, it, expect } from 'vitest';
import { presentationToKeyboard, CALLBACK_COMMAND } from '../../src/bitrix24/buttons.js';

describe('presentationToKeyboard', () => {
  it('returns undefined when there are no button blocks', () => {
    expect(presentationToKeyboard(undefined)).toBeUndefined();
    expect(presentationToKeyboard({ blocks: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
    expect(presentationToKeyboard({ blocks: [] })).toBeUndefined();
  });

  it('maps a URL button to a LINK button', () => {
    const kb = presentationToKeyboard({
      blocks: [{ type: 'buttons', buttons: [{ label: 'Открыть сайт', url: 'https://bitrix24.ru' }] }],
    });
    expect(kb).toEqual({
      BUTTONS: [{ TEXT: 'Открыть сайт', LINK: 'https://bitrix24.ru', DISPLAY: 'LINE' }],
    });
  });

  it('maps a callback button (action.value) to a COMMAND button with the sentinel', () => {
    const kb = presentationToKeyboard({
      blocks: [
        { type: 'buttons', buttons: [{ label: 'Подтвердить', action: { type: 'command', value: 'approve_42' } }] },
      ],
    });
    expect(kb!.BUTTONS[0]).toEqual({
      TEXT: 'Подтвердить',
      COMMAND: CALLBACK_COMMAND,
      COMMAND_PARAMS: 'approve_42',
      DISPLAY: 'LINE',
    });
  });

  it('accepts the legacy top-level value field', () => {
    const kb = presentationToKeyboard({
      blocks: [{ type: 'buttons', buttons: [{ label: 'Да', value: 'yes' }] }],
    });
    expect(kb!.BUTTONS[0].COMMAND_PARAMS).toBe('yes');
  });

  it('separates multiple button blocks into rows with NEWLINE', () => {
    const kb = presentationToKeyboard({
      blocks: [
        { type: 'buttons', buttons: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
        { type: 'buttons', buttons: [{ label: 'C', value: 'c' }] },
      ],
    });
    const shapes = kb!.BUTTONS.map((b) => b.TYPE === 'NEWLINE' ? 'NL' : b.TEXT);
    expect(shapes).toEqual(['A', 'B', 'NL', 'C']);
  });

  it('skips bare text buttons with no url/callback', () => {
    const kb = presentationToKeyboard({
      blocks: [{ type: 'buttons', buttons: [{ label: 'no-op' }, { label: 'go', url: 'https://x.io' }] }],
    });
    expect(kb!.BUTTONS.map((b) => b.TEXT)).toEqual(['go']);
  });

  it('truncates over-long labels and drops empty ones', () => {
    const kb = presentationToKeyboard({
      blocks: [{ type: 'buttons', buttons: [
        { label: 'x'.repeat(100), value: 'v' },
        { label: '', value: 'v2' },
      ] }],
    });
    expect(kb!.BUTTONS).toHaveLength(1);
    expect(kb!.BUTTONS[0].TEXT!.length).toBe(60);
  });
});
