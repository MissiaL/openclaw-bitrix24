import type { Bitrix24Client } from './client.js';
import type { BotConfig, BotRegistrationResult } from './types.js';

/**
 * Build the single v2 webhook URL for an account. v2 has exactly one
 * `webhookUrl` per bot (no per-event handler URLs); Bitrix24 internally fans
 * it out to all `ONIMBOTV2*` event subscriptions.
 */
function buildWebhookUrl(webhookBaseUrl: string, accountId: string): string {
  const base = webhookBaseUrl.replace(/\/$/, '');
  return `${base}/webhook/bitrix24/${accountId}`;
}

/**
 * Register an OpenClaw chatbot in a Bitrix24 portal via `imbot.v2.Bot.register`.
 *
 * Idempotent on `fields.code`: a repeat call with the same code returns the
 * existing bot without updating it (use `updateBot`/`updateBotEventUrls` to
 * change fields on an already-registered bot).
 */
export async function registerBot(
  client: Bitrix24Client,
  accountId: string,
  webhookBaseUrl: string,
  config: BotConfig,
): Promise<BotRegistrationResult> {
  if (!config.clientId) {
    throw new Error('Bot botToken (config bot.clientId) is required for imbot.v2.Bot.register');
  }

  const code = `openclaw_${accountId}`;
  const webhookUrl = buildWebhookUrl(webhookBaseUrl, accountId);

  const properties: Record<string, any> = {
    name: config.name,
    lastName: config.lastName ?? '',
    color: config.color ?? 'PURPLE',
    workPosition: config.workPosition ?? 'AI Assistant',
  };
  if (config.avatar) properties.avatar = config.avatar;

  const result = await client.callMethod('imbot.v2.Bot.register', {
    fields: {
      code,
      // config.clientId (aka account bot.clientId, an md5 derived in
      // accounts.ts) is reused as the v2 `botToken` — see the doc-comment
      // on BotConfig.clientId in types.ts.
      botToken: config.clientId,
      eventMode: 'webhook',
      webhookUrl,
      type: 'bot',
      properties,
    },
  });

  return { botId: Number(result.bot.id), botCode: result.bot.code };
}

/**
 * Update bot properties (name, avatar, etc.) via `imbot.v2.Bot.update`.
 */
export async function updateBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
  config: Partial<BotConfig>,
): Promise<void> {
  const properties: Record<string, any> = {};
  if (config.name !== undefined) properties.name = config.name;
  if (config.lastName !== undefined) properties.lastName = config.lastName;
  if (config.color !== undefined) properties.color = config.color;
  if (config.workPosition !== undefined) properties.workPosition = config.workPosition;
  if (config.avatar !== undefined) properties.avatar = config.avatar;

  if (Object.keys(properties).length === 0) return;

  await client.callMethod('imbot.v2.Bot.update', {
    botId,
    botToken: botClientId,
    fields: { properties },
  });
}

/**
 * Force an already-registered bot into `eventMode: 'webhook'` at the given
 * base URL via `imbot.v2.Bot.update`.
 *
 * `imbot.v2.Bot.register` is idempotent on `fields.code`: a repeat call
 * against an EXISTING bot (e.g. a bot that pre-dates this v2 migration, or
 * was registered by a different token) returns that bot unchanged — it does
 * NOT flip `eventMode` to `webhook` or set `webhookUrl` (spec §1). Without an
 * explicit `Bot.update` immediately after register, such a bot would silently
 * stay in `fetch` mode (or point at a stale URL) and never deliver events.
 * `Bot.update` re-syncs all 8 `ONIMBOTV2*` subscriptions as a side effect
 * (spec §2), so this single call is sufficient to bring the bot fully online.
 *
 * Throws `Bitrix24Error` (e.g. `BOT_OWNERSHIP_ERROR`) if the bot is owned by
 * a different token than `botClientId` — callers must catch this and warn
 * rather than crash, since it indicates a pre-existing bot needs manual
 * re-registration on the portal.
 */
export async function ensureWebhookMode(
  client: Bitrix24Client,
  params: { botId: number; botClientId: string; accountId: string; webhookBaseUrl: string },
): Promise<void> {
  const webhookUrl = buildWebhookUrl(params.webhookBaseUrl, params.accountId);
  await client.callMethod('imbot.v2.Bot.update', {
    botId: params.botId,
    botToken: params.botClientId,
    fields: { eventMode: 'webhook', webhookUrl },
  });
}

/**
 * Point an already-registered bot's webhook URL at a new public base URL.
 *
 * `imbot.v2.Bot.register` with an existing `code` returns the existing bot
 * but does NOT refresh its `webhookUrl`, so a publicUrl change requires an
 * explicit `imbot.v2.Bot.update` call. Bitrix24 automatically re-points the
 * bot's 8 internal `ONIMBOTV2*` event subscriptions to the new URL — no
 * manual event.bind/unbind is needed.
 */
export async function updateBotEventUrls(
  client: Bitrix24Client,
  params: { botId: number; botClientId: string; accountId: string; webhookBaseUrl: string },
): Promise<void> {
  const webhookUrl = buildWebhookUrl(params.webhookBaseUrl, params.accountId);
  await client.callMethod('imbot.v2.Bot.update', {
    botId: params.botId,
    botToken: params.botClientId,
    fields: { webhookUrl },
  });
}

/**
 * Unregister (delete) the bot from Bitrix24 via `imbot.v2.Bot.unregister`.
 */
export async function unregisterBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
): Promise<void> {
  await client.callMethod('imbot.v2.Bot.unregister', {
    botId,
    botToken: botClientId,
  });
}
