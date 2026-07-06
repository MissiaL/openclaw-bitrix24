import { describe, it, expect, vi } from 'vitest';
import register from '../../extensions/bitrix24/src/index.js';

function makeFakeApi(overrides: Record<string, any> = {}) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {},
    registerChannel: vi.fn(),
    registerService: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerCommand: vi.fn(),
    persistConfig: vi.fn(),
    runtime: { config: { mutateConfigFile: vi.fn().mockResolvedValue(undefined) } },
    ...overrides,
  };
}

describe('plugin register(api)', () => {
  it('registers webhook prefix route with plugin auth', () => {
    const api = makeFakeApi();
    register(api);
    expect(api.registerHttpRoute).toHaveBeenCalledOnce();
    const params = api.registerHttpRoute.mock.calls[0][0];
    expect(params.path).toBe('/webhook/bitrix24/');
    expect(params.match).toBe('prefix');
    expect(params.auth).toBe('plugin');
    expect(typeof params.handler).toBe('function');

    // Both registrations must happen in the same run: modern hosts use the
    // HTTP route above, but registerService.router is still wired for older
    // hosts that ignore registerHttpRoute.
    expect(api.registerService).toHaveBeenCalledOnce();
    const service = api.registerService.mock.calls[0][0];
    expect(service.id).toBe('bitrix24-webhook');
    expect(service.router).toBeDefined();
  });

  it('keeps legacy service router for older hosts', () => {
    const api = makeFakeApi({ registerHttpRoute: undefined });
    expect(() => register(api)).not.toThrow();
    const service = api.registerService.mock.calls[0][0];
    expect(service.id).toBe('bitrix24-webhook');
    expect(service.router).toBeDefined();
  });

  it('declares complete channel meta (docsPath, blurb, labels)', () => {
    const api = makeFakeApi();
    register(api);
    const meta = api.registerChannel.mock.calls[0][0].plugin.meta;
    expect(meta.docsPath).toBe('/channels/bitrix24');
    expect(meta.label).toBeTruthy();
    expect(meta.selectionLabel).toBeTruthy();
    expect(meta.blurb).toBeTruthy();
  });
});
