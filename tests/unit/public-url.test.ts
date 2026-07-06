import { describe, it, expect } from 'vitest';
import { resolvePublicUrl } from '../../extensions/bitrix24/src/public-url.js';

describe('resolvePublicUrl', () => {
  it('prefers channels.bitrix24.publicUrl', () => {
    expect(resolvePublicUrl(
      { channels: { bitrix24: { publicUrl: 'https://a.example' } }, gateway: { externalUrl: 'https://b.example' } },
      { BITRIX24_PUBLIC_URL: 'https://c.example' },
    )).toBe('https://a.example');
  });

  it('falls back to BITRIX24_PUBLIC_URL env', () => {
    expect(resolvePublicUrl(
      { gateway: { externalUrl: 'https://b.example' } },
      { BITRIX24_PUBLIC_URL: 'https://c.example' },
    )).toBe('https://c.example');
  });

  it('falls back to legacy gateway.externalUrl', () => {
    expect(resolvePublicUrl({ gateway: { externalUrl: 'https://b.example' } }, {})).toBe('https://b.example');
  });

  it('defaults to localhost gateway port', () => {
    expect(resolvePublicUrl(undefined, {})).toBe('http://localhost:18789');
  });

  it('strips trailing slash', () => {
    expect(resolvePublicUrl(
      { channels: { bitrix24: { publicUrl: 'https://a.example/' } } }, {},
    )).toBe('https://a.example');
  });
});
