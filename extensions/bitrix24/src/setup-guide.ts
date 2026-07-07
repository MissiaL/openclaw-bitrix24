/**
 * Setup guide texts for the Bitrix24 plugin.
 * Separated into a module for easy updates and localization.
 */

/**
 * Full step-by-step instructions shown when /b24setup is called without args.
 */
export function getSetupInstructions(): string {
  return [
    '**Bitrix24 Setup**',
    '',
    '**Step 1.** Open your Bitrix24 portal in a browser',
    '',
    '**Step 2.** Go to **Developer resources** (left menu, bottom) → **Other** → **Inbound webhook**',
    '',
    '**Step 3.** Enable these scopes:',
    '  - `imbot` — bot registration',
    '  - `im` — messaging',
    '  - `disk` — file transfer',
    '  - (optional) `crm`, `task`, `calendar`, `user`, `department` — for full CRM/task functionality',
    '',
    '**Step 4.** Click **Save** and copy the **Webhook URL**',
    '  It looks like: `https://your-portal.bitrix24.ru/rest/1/abc123def456/`',
    '',
    '**Step 5.** Run this command with your URL:',
    '```',
    '/b24setup https://your-portal.bitrix24.ru/rest/1/your-secret/',
    '```',
    '',
    'Or set the env var: `export BITRIX24_WEBHOOK_URL="https://..."`',
  ].join('\n');
}

/**
 * Short hint for logs when no webhook is configured.
 */
export function getQuickHint(): string {
  return 'No Bitrix24 webhook URL configured. Run /b24setup for step-by-step instructions.';
}

/**
 * Format successful connection result.
 */
export function formatConnectionSuccess(result: {
  domain: string;
  scopes: string[];
  botRegistered?: boolean;
}): string {
  const lines = [
    `Connected to **${result.domain}**`,
    `Scopes: ${result.scopes.join(', ')}`,
  ];
  if (result.botRegistered) {
    lines.push('Bot registered in Bitrix24 Messenger — you can now start chatting!');
  }
  return lines.join('\n');
}

/**
 * Format connection error.
 */
export function formatConnectionError(error: string): string {
  return [
    `Connection failed: ${error}`,
    '',
    'Check that:',
    '- The webhook URL is correct',
    '- The webhook is not expired/revoked in Bitrix24',
    '- Required scopes are enabled: `imbot`, `im`, `disk`',
  ].join('\n');
}

/**
 * Format missing scopes warning.
 */
export function formatMissingScopes(missing: string[]): string {
  return [
    `Connected, but missing required scopes: **${missing.join(', ')}**`,
    '',
    'Go to Bitrix24 → Developer resources → edit your webhook → enable the missing scopes.',
  ].join('\n');
}

/**
 * Welcome message sent when bot is added to a Bitrix24 chat.
 * Explains capabilities and gives usage examples. Russian: the portal's
 * working language (see chat.md skill docs); Bitrix delivers the event
 * with language:"ru" on the client portals this plugin targets.
 */
export function getWelcomeMessage(): string {
  return [
    'Привет! Я OpenClaw-агент, подключённый к этому порталу Битрикс24.',
    '',
    'Чем могу помочь:',
    '',
    '**CRM** — сделки, контакты, лиды, компании',
    '  «Покажи мои открытые сделки»',
    '  «Создай лид: Иван Смирнов, +7 900 123-45-67»',
    '  «Какие звонки были сегодня?»',
    '',
    '**Задачи** — создать, отследить, делегировать',
    '  «Создай задачу: подготовить отчёт за квартал, срок — пятница»',
    '  «Какие задачи назначены на меня?»',
    '',
    '**Файлы и документы** — пришлите файл, я его разберу',
    '  «Что это за документ?» (с вложением)',
    '  «Сформируй файл со сводкой и пришли сюда»',
    '',
    '**Сообщения и календарь**',
    '  «Отправь Анне: встреча переносится на 15:00»',
    '  «Что у меня в календаре на завтра?»',
    '',
    'Можно отвечать на конкретное сообщение (цитатой) — я увижу контекст.',
    '',
    '**Команды:**',
    '  /status — статус и лимиты подписки',
    '  /new — начать новую сессию',
    '  /stop — прервать текущую задачу',
    '  /restart — перезапустить бота на сервере',
    '',
    'Просто напишите запрос обычным языком — остальное я сделаю сам!',
  ].join('\n');
}

/**
 * Validate webhook URL format.
 */
export function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /\/rest\/\d+\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}
