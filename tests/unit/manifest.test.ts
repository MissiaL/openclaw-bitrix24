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

  it('declares opt-in dynamic agent settings at channel and account levels', () => {
    const properties = manifest.configSchema.properties;
    const accountProperties = properties.accounts.items.properties;

    expect(properties.configWrites).toMatchObject({ type: 'boolean', default: false });
    expect(properties.dynamicAgentCreation.properties.enabled).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(properties.dynamicAgentCreation.properties.maxAgents).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(properties.dynamicAgentCreation.properties.bootstrapFiles).toMatchObject({
      type: 'array',
      items: { type: 'string', minLength: 1 },
    });

    expect(accountProperties.configWrites).toEqual(properties.configWrites);
    expect(accountProperties.dynamicAgentCreation).toEqual(properties.dynamicAgentCreation);
  });
});
