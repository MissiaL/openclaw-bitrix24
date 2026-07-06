import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../extensions/bitrix24/openclaw.plugin.json', import.meta.url)), 'utf8'),
);

describe('openclaw.plugin.json', () => {
  it('declares channelConfigs for the bitrix24 channel', () => {
    const cc = manifest.channelConfigs?.bitrix24;
    expect(cc).toBeDefined();
    expect(cc.schema?.type).toBe('object');
    expect(cc.schema.properties.webhookUrl).toBeDefined();
    expect(cc.schema.properties.publicUrl).toBeDefined();
    expect(cc.label).toBe('Bitrix24');
  });

  it('keeps publicUrl in the top-level configSchema too', () => {
    expect(manifest.configSchema.properties.publicUrl).toBeDefined();
  });

  it('keeps channelConfigs copies in sync with the top-level schema and uiHints', () => {
    expect(manifest.channelConfigs.bitrix24.schema).toEqual(manifest.configSchema);
    expect(manifest.channelConfigs.bitrix24.uiHints).toEqual(manifest.uiHints);
  });
});
