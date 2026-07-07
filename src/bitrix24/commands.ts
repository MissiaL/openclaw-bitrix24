import type { Bitrix24Client } from './client.js';

/**
 * Bot slash-command registration (Chatbots 2.0).
 *
 * LIVE-VERIFIED 2026-07-07 on a real portal:
 *   - `imbot.v2.Command.register` takes `{botId, botToken, fields: {command, title}}`
 *     where `command` has NO leading slash and `title` is a locale map
 *     (`{ru: "...", en: "..."}`) — a plain string fails with
 *     COMMAND_TITLE_REQUIRED;
 *   - `imbot.v2.Command.list` returns `{commands: [...]}` including the
 *     portal's built-in commands (id "def0"... with botId 0) — filter by
 *     botId to see only this bot's commands; `command` comes back WITH the
 *     leading slash;
 *   - `imbot.v2.Command.unregister` takes `{botId, botToken, commandId}`.
 *
 * Invocations arrive as ONIMBOTV2COMMANDADD webhook events.
 */
export interface BotCommandSpec {
  /** Command name without the leading slash (e.g. "status"). */
  command: string;
  /** Locale map shown in the chat's command menu. */
  title: Record<string, string>;
}

/** Default command menu: openclaw built-ins the agent host handles natively. */
export const DEFAULT_BOT_COMMANDS: BotCommandSpec[] = [
  {
    command: 'status',
    title: { ru: 'Статус и лимиты подписки', en: 'Status and subscription limits' },
  },
  { command: 'new', title: { ru: 'Начать новую сессию', en: 'Start a new session' } },
  { command: 'stop', title: { ru: 'Прервать текущую задачу', en: 'Stop the current task' } },
  {
    command: 'restart',
    title: { ru: 'Перезапустить бота на сервере', en: 'Restart the bot on the server' },
  },
];

/**
 * Idempotently register the bot's slash commands: list what the portal
 * already has for this bot and register only the missing ones.
 */
export async function ensureBotCommands(
  client: Bitrix24Client,
  params: {
    botId: number;
    botToken: string;
    commands?: BotCommandSpec[];
  },
): Promise<{ registered: string[] }> {
  const commands = params.commands ?? DEFAULT_BOT_COMMANDS;
  const listResult = await client.callMethod<{ commands: Array<Record<string, unknown>> }>(
    'imbot.v2.Command.list',
    { botId: params.botId, botToken: params.botToken },
  );
  const existing = new Set(
    (listResult?.commands ?? [])
      .filter((c) => String(c.botId) === String(params.botId))
      .map((c) => String(c.command ?? '').replace(/^\//, '')),
  );

  const registered: string[] = [];
  for (const spec of commands) {
    if (existing.has(spec.command)) continue;
    await client.callMethod('imbot.v2.Command.register', {
      botId: params.botId,
      botToken: params.botToken,
      fields: { command: spec.command, title: spec.title },
    });
    registered.push(spec.command);
  }
  return { registered };
}
