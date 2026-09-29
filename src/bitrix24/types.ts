// ── Auth ──────────────────────────────────────────────────────────────────────

export interface WebhookAuth {
  type: 'webhook';
  webhookUrl: string; // https://{domain}/rest/{userId}/{secret}/
}

export interface OAuthAuth {
  type: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // unix ms
  clientId?: string;
  clientSecret?: string;
}

export type BitrixAuth = WebhookAuth | OAuthAuth;

export interface Bitrix24ClientConfig {
  domain: string;
  auth: BitrixAuth;
  /** Base delay in ms for rate-limit retry backoff (delay = baseDelayMs * 2^attempt), default 1000. */
  rateLimitBaseDelayMs?: number;
  /** Called after OAuth tokens are refreshed. Use to persist new tokens. */
  onTokenRefresh?: (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }) => void | Promise<void>;
}

// ── Bot ──────────────────────────────────────────────────────────────────────

export interface BotConfig {
  name: string;
  lastName?: string;
  color?: BotColor;
  workPosition?: string;
  avatar?: string; // base64
  /**
   * Secret token reused across all bot lifecycle calls for this bot.
   * Historically Bitrix24 v1's `CLIENT_ID`; since the imbot.v2 migration this
   * same value (an md5 hash, 32 hex chars — see `deriveBotClientId` in
   * accounts.ts) is sent as v2's `botToken` param (max 40 chars). The config
   * field name (`bot.clientId`) is kept for backward compatibility.
   */
  clientId?: string;
}

export type BotColor =
  | 'RED' | 'GREEN' | 'MINT' | 'LIGHT_BLUE' | 'DARK_BLUE'
  | 'PURPLE' | 'AQUA' | 'PINK' | 'LIME' | 'BROWN'
  | 'AZURE' | 'KHAKI' | 'SAND' | 'MARENGO' | 'GRAY' | 'GRAPHITE';

export interface BotRegistrationResult {
  botId: number;
  botCode: string;
}

// ── Account ──────────────────────────────────────────────────────────────────

export interface AccountConfig {
  id: string;
  domain: string;
  auth: BitrixAuth;
  enabled: boolean;
  textChunkLimit: number; // default 18000
  bot: BotConfig;
  botId?: number;
  botCode?: string;
  dmPolicy: 'open' | 'paired';
  configWrites: boolean;
  dynamicAgentCreation?: DynamicAgentCreationConfig;
  /**
   * Bitrix user ids allowed to run control commands (/status, /new, /stop,
   * /restart, ...). '*' allows everyone. Empty/absent = commands disabled
   * (safe default: the bot is reachable by every portal employee).
   */
  commandUsers: string[];
  /**
   * Bitrix user ids allowed to talk to the bot at all ('*' = everyone).
   * Undefined = everyone (backward compatible). Others get a refusal and the
   * message never reaches the agent.
   */
  allowUsers?: string[];
  /**
   * TOFU-pinned webhook authenticity token (top-level `auth.application_token`,
   * see `verifyApplicationToken` in receive.ts). Undefined until the first
   * webhook event for this account is captured.
   */
  applicationToken?: string;
}

export interface DynamicAgentCreationConfig {
  enabled?: boolean;
  sourceAgentId?: string;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  bootstrapFiles?: string[];
  maxAgents?: number;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface IncomingMessage {
  messageId: number;
  dialogId: string;
  chatId?: number;
  text: string;
  fromUserId: number;
  fromUserName: string;
  fromUserLastName: string;
  isBot: boolean;
  chatType: ChatType;
  files: FileAttachment[];
  /** Id of the quoted message when the user replied/quoted (params.REPLY_ID). */
  replyToMessageId?: string;
  domain: string;
  applicationToken?: string;
  botId: number;
  botCode: string;
}

export type ChatType = 'P' | 'C' | 'O' | 'S';

export interface OutgoingMessage {
  botId: number;
  botClientId: string;
  dialogId: string;
  text: string;
  media?: MediaAttachment[];
  keyboard?: KeyboardMarkup;
}

// ── Files ────────────────────────────────────────────────────────────────────

/**
 * A file referenced by an inbound message (`params.FILE_ID`). Resolve the
 * bytes later via `imbot.v2.File.download` (files.ts:downloadFile).
 */
export interface FileAttachment {
  id: string;
  name?: string;
}

export interface MediaAttachment {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

export interface KeyboardButton {
  TEXT: string;
  LINK?: string;
  COMMAND?: string;
  COMMAND_PARAMS?: string;
  BG_COLOR?: string;
  TEXT_COLOR?: string;
  BLOCK?: 'Y' | 'N';
}

export interface KeyboardMarkup {
  buttons: KeyboardButton[][];
}

// ── Bitrix24 imbot.v2 Event Payloads ─────────────────────────────────────────
//
// v2 webhook events (ONIMBOTV2*) use nested camelCase keys (no more UPPER_CASE
// PARAMS blocks). Delivered as `application/x-www-form-urlencoded` via PHP's
// http_build_query, so in webhook mode EVERY scalar arrives as a string:
// integers like `789`, booleans as `"1"`/`"0"`, null as `""` (spec §7). These
// interfaces model that webhook-mode shape (string-typed scalars); parsers in
// receive.ts coerce fields into the numeric types `IncomingMessage` expects.

/**
 * Bot object as it appears nested in v2 webhook event payloads. (Its optional
 * `auth` bundle is for REST calls back as the bot — distinct from the
 * top-level `auth` used by `verifyApplicationToken` — and is not read here.)
 */
export interface Bitrix24V2EventBot {
  id: string;
  code: string;
}

/** Only the fields the parsers read; the payload carries many more. */
export interface Bitrix24V2EventMessage {
  id: string;
  chatId: string;
  /** `"0"` = system message. */
  authorId: string;
  text: string;
  isSystem?: string;
  /**
   * "Additional parameters: attach, keyboard, files, and others" — no exact
   * sub-schema is documented (spec §11). Parsed defensively in receive.ts.
   */
  params?: Record<string, unknown>;
}

export interface Bitrix24V2EventChat {
  id: string;
  /** `chat5`-style for groups, bare `{userId}` for private (P2P) dialogs. */
  dialogId: string;
  type: string; // 'chat' | 'open' | 'channel' | 'openChannel' | 'copilot' | 'thread' | 'generalChannel'
}

export interface Bitrix24V2EventUser {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  /** `"1"`/`"0"` — true when the message author is itself a bot. */
  bot?: string;
}

/**
 * Top-level `auth` object — sibling of `event`/`data`/`ts`, always present.
 * Used to verify webhook authenticity via `auth.application_token`
 * (snake_case; distinct from `data.bot.auth`, see `verifyApplicationToken`).
 */
export interface Bitrix24V2TopLevelAuth {
  domain: string;
  application_token?: string;
}

export interface Bitrix24MessageEvent {
  event: 'ONIMBOTV2MESSAGEADD';
  data: {
    bot: Bitrix24V2EventBot;
    message: Bitrix24V2EventMessage;
    chat: Bitrix24V2EventChat;
    user: Bitrix24V2EventUser;
    language?: string;
  };
  ts?: string;
  auth?: Bitrix24V2TopLevelAuth;
}

export interface Bitrix24WelcomeEvent {
  event: 'ONIMBOTV2JOINCHAT';
  data: {
    bot: Bitrix24V2EventBot;
    dialogId?: string;
    chat?: Bitrix24V2EventChat;
    user?: Bitrix24V2EventUser;
    language?: string;
  };
  ts?: string;
  auth?: Bitrix24V2TopLevelAuth;
}

/** "The last event the bot will receive." Payload is just `{bot: {...}}` — no chat/user/message/language (spec §10). */
export interface Bitrix24BotDeleteEvent {
  event: 'ONIMBOTV2DELETE';
  data: {
    bot: Bitrix24V2EventBot;
  };
  ts?: string;
  auth?: Bitrix24V2TopLevelAuth;
}

// ── REST API Response ────────────────────────────────────────────────────────

export interface BitrixApiResponse<T = any> {
  result: T;
  time?: {
    start: number;
    finish: number;
    duration: number;
  };
  error?: string;
  error_description?: string;
}
