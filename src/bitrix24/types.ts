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
  rateLimit?: number; // req/sec, default 2
  timeout?: number;   // ms, default 30000
  /** Max retries on a Bitrix24 rate-limit error (QUERY_LIMIT_EXCEEDED / OVERLOAD_LIMIT / OPERATION_TIME_LIMIT / HTTP 503), default 3. */
  rateLimitMaxRetries?: number;
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
  email?: string;
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
  textChunkLimit: number; // default 4000
  bot: BotConfig;
  botId?: number;
  botCode?: string;
  dmPolicy: 'open' | 'paired';
  /**
   * TOFU-pinned webhook authenticity token (top-level `auth.application_token`,
   * see `verifyApplicationToken` in receive.ts). Undefined until the first
   * webhook event for this account is captured.
   */
  applicationToken?: string;
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
 * A file referenced by an inbound message. Only `id` is guaranteed —
 * the inbound shape is UNVERIFIABLE (spec §11); `name`/`size` are populated
 * on a best-effort basis by the defensive parser in receive.ts and are
 * absent entirely for ids recovered only from a `[disk=N]`-style text token.
 * Resolve the bytes later via `imbot.v2.File.download` (files.ts:downloadFile).
 */
export interface FileAttachment {
  id: string;
  name?: string;
  size?: number;
  downloadUrl?: string;
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

/** Bot object as it appears nested in v2 webhook event payloads. */
export interface Bitrix24V2EventBot {
  id: string;
  code: string;
  /**
   * OAuth-style token bundle for making REST calls back as the bot. Not
   * always present — Bitrix24 omits it when the triggering hit couldn't be
   * linked to a specific user (spec §7). Distinct from the top-level `auth`
   * used to verify webhook authenticity (see `verifyApplicationToken`).
   */
  auth?: {
    access_token?: string;
    refresh_token?: string;
    application_token?: string;
    domain?: string;
    expires_in?: string;
    scope?: string;
    server_endpoint?: string;
    status?: string;
    client_endpoint?: string;
    member_id?: string;
  };
}

export interface Bitrix24V2EventMessage {
  id: string;
  chatId: string;
  /** `"0"` = system message. */
  authorId: string;
  date?: string;
  text: string;
  isSystem?: string;
  uuid?: string;
  forward?: { id: string; userId: string; chatId: string; date: string } | null;
  /**
   * "Additional parameters: attach, keyboard, files, and others" per the
   * docs — no exact sub-schema for `params.files` is documented anywhere in
   * the v2 API (spec §11, marked UNVERIFIABLE). Left untyped here; parsed
   * defensively by `extractInboundFiles` in receive.ts.
   */
  params?: Record<string, unknown>;
  viewedByOthers?: string;
}

export interface Bitrix24V2EventChat {
  id: string;
  /** `chat5`-style for groups, bare `{userId}` for private (P2P) dialogs. */
  dialogId: string;
  type: string; // 'chat' | 'open' | 'channel' | 'openChannel' | 'copilot' | 'thread' | 'generalChannel'
  name?: string;
  entityType?: string;
  owner?: string;
  avatar?: string;
  color?: string;
}

export interface Bitrix24V2EventUser {
  id: string;
  active?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  workPosition?: string;
  color?: string;
  avatar?: string;
  gender?: string;
  birthday?: string;
  extranet?: string;
  /** `"1"`/`"0"` — true when the message author is itself a bot. */
  bot?: string;
  connector?: string;
  externalAuthId?: string;
  status?: string;
  idle?: string;
  lastActivityDate?: string;
  absent?: string;
  departments?: string[];
  phones?: string;
  type?: string;
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

// ── Token Resolution ─────────────────────────────────────────────────────────

export interface TokenResolutionConfig {
  accountWebhookUrl?: string;
  globalWebhookUrl?: string;
  envVar?: string; // BITRIX24_WEBHOOK_URL
}
