import type { Bitrix24Client } from './client.js';
import type { BotConfig, BotRegistrationResult } from './types.js';

/**
 * Register an OpenClaw chatbot in a Bitrix24 portal.
 */
export async function registerBot(
  client: Bitrix24Client,
  accountId: string,
  webhookBaseUrl: string,
  config: BotConfig,
): Promise<BotRegistrationResult> {
  if (!config.clientId) {
    throw new Error('Bot CLIENT_ID is required for imbot.register');
  }

  const code = `openclaw_${accountId}`;
  const base = webhookBaseUrl.replace(/\/$/, '');

  const result = await client.callMethod('imbot.register', {
    CLIENT_ID: config.clientId,
    CODE: code,
    TYPE: 'B',
    EVENT_MESSAGE_ADD: `${base}/webhook/bitrix24/${accountId}/message`,
    EVENT_WELCOME_MESSAGE: `${base}/webhook/bitrix24/${accountId}/welcome`,
    EVENT_BOT_DELETE: `${base}/webhook/bitrix24/${accountId}/delete`,
    PROPERTIES: {
      NAME: config.name,
      LAST_NAME: config.lastName ?? '',
      COLOR: config.color ?? 'PURPLE',
      WORK_POSITION: config.workPosition ?? 'AI Assistant',
      EMAIL: config.email ?? `openclaw-${accountId}@openclaw.bot`,
      PERSONAL_PHOTO: config.avatar,
    },
  });

  // Bitrix24 returns BOT_ID as a plain number or as { BOT_ID: n }
  const botId = typeof result === 'number' ? result : result?.BOT_ID ?? result;

  return { botId: Number(botId), botCode: code };
}

/**
 * Update bot properties (name, avatar, etc.).
 */
export async function updateBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
  config: Partial<BotConfig>,
): Promise<void> {
  const fields: Record<string, any> = {};
  if (config.name !== undefined) fields.NAME = config.name;
  if (config.lastName !== undefined) fields.LAST_NAME = config.lastName;
  if (config.color !== undefined) fields.COLOR = config.color;
  if (config.workPosition !== undefined) fields.WORK_POSITION = config.workPosition;
  if (config.avatar !== undefined) fields.PERSONAL_PHOTO = config.avatar;

  if (Object.keys(fields).length === 0) return;

  await client.callMethod('imbot.update', {
    CLIENT_ID: botClientId,
    BOT_ID: botId,
    FIELDS: fields,
  });
}

/**
 * Point an already-registered bot's event handlers at a new public base URL.
 *
 * imbot.register with an existing CODE returns the existing BOT_ID but does
 * NOT refresh event URLs, so a publicUrl change requires an explicit update.
 */
export async function updateBotEventUrls(
  client: Bitrix24Client,
  params: { botId: number; botClientId: string; accountId: string; webhookBaseUrl: string },
): Promise<void> {
  const base = params.webhookBaseUrl.replace(/\/$/, '');
  await client.callMethod('imbot.update', {
    CLIENT_ID: params.botClientId,
    BOT_ID: params.botId,
    FIELDS: {
      EVENT_MESSAGE_ADD: `${base}/webhook/bitrix24/${params.accountId}/message`,
      EVENT_WELCOME_MESSAGE: `${base}/webhook/bitrix24/${params.accountId}/welcome`,
      EVENT_BOT_DELETE: `${base}/webhook/bitrix24/${params.accountId}/delete`,
    },
  });
}

/**
 * Unregister (delete) the bot from Bitrix24.
 */
export async function unregisterBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
): Promise<void> {
  await client.callMethod('imbot.unregister', {
    CLIENT_ID: botClientId,
    BOT_ID: botId,
  });
}
