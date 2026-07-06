import { describe, it, expect, vi } from 'vitest';
import { setConfigPath, persistConfigValue } from '../../extensions/bitrix24/src/persist.js';

describe('setConfigPath', () => {
  it('creates a nested path on an empty object', () => {
    const draft: any = {};
    setConfigPath(draft, ['channels', 'bitrix24', 'registeredWebhookBase', 'default'], 'https://example.com');
    expect(draft).toEqual({
      channels: {
        bitrix24: {
          registeredWebhookBase: {
            default: 'https://example.com',
          },
        },
      },
    });
  });

  it('keeps a dot-containing segment as a single key (dot-safe)', () => {
    const draft: any = {};
    setConfigPath(draft, ['channels', 'bitrix24', 'registeredWebhookBase', 'a.b'], 'https://example.com');
    expect(draft.channels.bitrix24.registeredWebhookBase).toEqual({
      'a.b': 'https://example.com',
    });
    expect(Object.keys(draft.channels.bitrix24.registeredWebhookBase)).toEqual(['a.b']);
  });

  it('overwrites an existing value at the path', () => {
    const draft: any = {
      channels: { bitrix24: { registeredWebhookBase: { default: 'https://old.example' } } },
    };
    setConfigPath(draft, ['channels', 'bitrix24', 'registeredWebhookBase', 'default'], 'https://new.example');
    expect(draft.channels.bitrix24.registeredWebhookBase.default).toBe('https://new.example');
  });

  it('throws on an empty segments array', () => {
    const draft: any = {};
    expect(() => setConfigPath(draft, [], 'value')).toThrow();
  });
});

describe('persistConfigValue', () => {
  it('calls mutateConfigFile once with afterWrite.mode "auto" and a mutate that applies the value', async () => {
    const mutateConfigFile = vi.fn().mockResolvedValue(undefined);
    const logger = { warn: vi.fn() };

    await persistConfigValue({
      mutateConfigFile,
      logger,
      segments: ['channels', 'bitrix24', 'registeredWebhookBase', 'default'],
      value: 'https://example.com',
    });

    expect(mutateConfigFile).toHaveBeenCalledOnce();
    const params = mutateConfigFile.mock.calls[0][0];
    expect(params.afterWrite).toEqual({ mode: 'auto' });
    expect(typeof params.mutate).toBe('function');

    // Apply the captured mutate to a fake draft and assert the real effect.
    const draft: any = {};
    params.mutate(draft);
    expect(draft.channels.bitrix24.registeredWebhookBase.default).toBe('https://example.com');

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('no-ops and warns when mutateConfigFile is undefined', async () => {
    const logger = { warn: vi.fn() };

    await persistConfigValue({
      mutateConfigFile: undefined,
      logger,
      segments: ['channels', 'bitrix24', 'registeredWebhookBase', 'default'],
      value: 'https://example.com',
    });

    expect(logger.warn).toHaveBeenCalledOnce();
    const message = logger.warn.mock.calls[0][0];
    expect(message).toContain('[bitrix24]');
    expect(message).toContain('not persisted');
  });
});
