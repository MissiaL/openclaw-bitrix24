import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAuth } from '../../src/bitrix24/token.js';

describe('resolveAuth', () => {
  beforeEach(() => {
    delete process.env.BITRIX24_WEBHOOK_URL;
  });

  it('resolves from per-account webhook URL', () => {
    const auth = resolveAuth({
      accountWebhookUrl: 'https://test.bitrix24.ru/rest/1/abc/',
      isDefault: false,
    });
    expect(auth).toEqual({
      type: 'webhook',
      webhookUrl: 'https://test.bitrix24.ru/rest/1/abc/',
    });
  });

  it('resolves from per-account OAuth token', () => {
    const auth = resolveAuth({
      accountAccessToken: 'token123',
      accountRefreshToken: 'refresh456',
      isDefault: false,
    });
    expect(auth).toMatchObject({
      type: 'oauth',
      accessToken: 'token123',
      refreshToken: 'refresh456',
    });
  });

  it('threads clientId, clientSecret, expiresAt into OAuthAuth', () => {
    const auth = resolveAuth({
      accountAccessToken: 'tok',
      accountRefreshToken: 'ref',
      accountClientId: 'cid',
      accountClientSecret: 'csecret',
      accountExpiresAt: 1700000000000,
      isDefault: false,
    });
    expect(auth).toEqual({
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'ref',
      clientId: 'cid',
      clientSecret: 'csecret',
      expiresAt: 1700000000000,
    });
  });

  it('omits undefined OAuth fields when not provided', () => {
    const auth = resolveAuth({
      accountAccessToken: 'tok',
      isDefault: false,
    });
    expect(auth).toEqual({
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: undefined,
      clientId: undefined,
      clientSecret: undefined,
      expiresAt: undefined,
    });
  });

  it('resolves from global config for default account', () => {
    const auth = resolveAuth({
      globalWebhookUrl: 'https://global.bitrix24.ru/rest/1/xyz/',
      isDefault: true,
    });
    expect(auth?.type).toBe('webhook');
  });

  it('resolves from env var for default account', () => {
    process.env.BITRIX24_WEBHOOK_URL = 'https://env.bitrix24.ru/rest/1/env123/';
    const auth = resolveAuth({
      isDefault: true,
    });
    expect(auth).toEqual({
      type: 'webhook',
      webhookUrl: 'https://env.bitrix24.ru/rest/1/env123/',
    });
  });

  it('returns null for non-default without credentials', () => {
    process.env.BITRIX24_WEBHOOK_URL = 'https://env.bitrix24.ru/rest/1/env123/';
    const auth = resolveAuth({
      isDefault: false,
    });
    expect(auth).toBeNull();
  });

  it('prefers account URL over global', () => {
    const auth = resolveAuth({
      accountWebhookUrl: 'https://account.bitrix24.ru/rest/1/acc/',
      globalWebhookUrl: 'https://global.bitrix24.ru/rest/1/glob/',
      isDefault: true,
    });
    expect((auth as any).webhookUrl).toBe('https://account.bitrix24.ru/rest/1/acc/');
  });
});
