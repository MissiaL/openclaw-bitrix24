import { createHash } from 'node:crypto';
import type {
  AccountConfig,
  BitrixAuth,
  BotConfig,
  DynamicAgentCreationConfig,
} from './types.js';
import { Bitrix24Client } from './client.js';
import { resolveAuth, extractDomain } from './token.js';

/**
 * Derive the bot's secret token (config field `bot.clientId`).
 *
 * This value is passed as `botToken` to every `imbot.v2.Bot.*` call (see
 * bot.ts). It used to be Bitrix24 v1's `CLIENT_ID`; the config field name is
 * kept unchanged for backward compatibility. md5 produces 32 hex chars,
 * comfortably within v2's 40-char `botToken` limit.
 */
function deriveBotClientId(auth: BitrixAuth, explicitClientId?: string): string | undefined {
  const provided = explicitClientId?.trim();
  if (provided) return provided;
  if (auth.type !== 'webhook') return undefined;

  // Stable secret-derived botToken (v2 fields.botToken, <=40 chars) for webhook-backed bots.
  return createHash('md5').update(auth.webhookUrl.replace(/\/$/, '')).digest('hex');
}

/**
 * Manage multiple Bitrix24 portal accounts.
 */
export class AccountManager {
  private accounts = new Map<string, AccountConfig>();
  private clients = new Map<string, Bitrix24Client>();
  private registeredWebhookBase = new Map<string, string>();
  private tokenRefreshCallback?: (accountId: string, tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }) => void | Promise<void>;

  /**
   * Load accounts from OpenClaw channel config.
   */
  loadFromConfig(config: RawChannelConfig): void {
    this.registeredWebhookBase = new Map(Object.entries(config.registeredWebhookBase ?? {}));

    const globalWebhookUrl = config.webhookUrl;

    const add = (raw: NonNullable<RawChannelConfig['accounts']>[number]): void => {
      const id = raw.id ?? 'default';

      const auth = resolveAuth({
        accountWebhookUrl: raw.webhookUrl,
        accountAccessToken: raw.accessToken,
        accountRefreshToken: raw.refreshToken,
        accountClientId: raw.clientId ?? config.clientId,
        accountClientSecret: raw.clientSecret ?? config.clientSecret,
        accountExpiresAt: raw.expiresAt,
        globalWebhookUrl,
        isDefault: id === 'default',
      });

      if (!auth) return;

      this.accounts.set(id, {
        id,
        domain: raw.domain ?? extractDomain(auth),
        auth,
        enabled: raw.enabled !== false,
        textChunkLimit: raw.textChunkLimit ?? 18000,
        bot: {
          name: raw.bot?.name ?? 'OpenClaw Agent',
          lastName: raw.bot?.lastName,
          color: raw.bot?.color ?? 'PURPLE',
          workPosition: raw.bot?.workPosition ?? 'AI Assistant',
          avatar: raw.bot?.avatar,
          clientId: deriveBotClientId(auth, raw.bot?.clientId),
        },
        botId: raw.botId,
        botCode: raw.botCode,
        dmPolicy: raw.dmPolicy ?? 'open',
        configWrites: raw.configWrites ?? config.configWrites ?? false,
        dynamicAgentCreation: raw.dynamicAgentCreation ?? config.dynamicAgentCreation,
        commandUsers: raw.commandUsers ?? config.commandUsers ?? [],
        allowUsers: raw.allowUsers ?? config.allowUsers,
        applicationToken: raw.applicationToken,
      });
    };

    (config.accounts ?? []).forEach(add);

    // No usable account entries but global/env auth available: implicit default.
    if (this.accounts.size === 0) add({});
  }

  listAccounts(): AccountConfig[] {
    return Array.from(this.accounts.values());
  }

  listEnabledAccounts(): AccountConfig[] {
    return this.listAccounts().filter((a) => a.enabled);
  }

  listAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  getAccount(id: string): AccountConfig | undefined {
    return this.accounts.get(id);
  }

  getDefaultAccount(): AccountConfig | undefined {
    return this.accounts.get('default') ?? this.accounts.values().next().value;
  }

  resolveDefaultAccountId(): string {
    return this.getDefaultAccount()?.id ?? 'default';
  }

  /**
   * Set callback for persisting refreshed OAuth tokens.
   */
  setTokenRefreshCallback(cb: (accountId: string, tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }) => void | Promise<void>): void {
    this.tokenRefreshCallback = cb;
  }

  /**
   * Get or create a Bitrix24Client for an account.
   */
  getClient(accountId: string): Bitrix24Client {
    let client = this.clients.get(accountId);
    if (client) return client;

    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Account "${accountId}" not found`);

    client = new Bitrix24Client({
      domain: account.domain,
      auth: account.auth,
      onTokenRefresh: this.tokenRefreshCallback
        ? (tokens) => this.tokenRefreshCallback!(accountId, tokens)
        : undefined,
    });
    this.clients.set(accountId, client);
    return client;
  }

  /**
   * Update stored bot info after registration.
   */
  setBotInfo(accountId: string, botId: number, botCode: string): void {
    const account = this.accounts.get(accountId);
    if (account) {
      account.botId = botId;
      account.botCode = botCode;
    }
  }

  /**
   * Get the TOFU-pinned application_token for an account, if any has been
   * captured yet (in-memory; see `Bitrix24Channel.captureApplicationToken`
   * for the durable-persist counterpart).
   */
  getApplicationToken(accountId: string): string | undefined {
    return this.accounts.get(accountId)?.applicationToken;
  }

  /**
   * Set the in-memory TOFU-pinned application_token for an account. No-ops
   * if the account is unknown (mirrors `setBotInfo`).
   */
  setApplicationToken(accountId: string, token: string): void {
    const account = this.accounts.get(accountId);
    if (account) {
      account.applicationToken = token;
    }
  }

  getRegisteredWebhookBase(accountId: string): string | undefined {
    return this.registeredWebhookBase.get(accountId);
  }

  setRegisteredWebhookBase(accountId: string, base: string): void {
    this.registeredWebhookBase.set(accountId, base);
  }

  /**
   * Find account by bot code (for routing incoming events).
   */
  findByBotCode(botCode: string): AccountConfig | undefined {
    for (const account of this.accounts.values()) {
      if (account.botCode === botCode) return account;
    }
    return undefined;
  }

  /**
   * Probe an account to verify connectivity.
   */
  async probeAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.getClient(accountId);
      return await client.probe();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Destroy all clients.
   */
  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }
}

// ── Config types from OpenClaw ───────────────────────────────────────────────

export interface RawChannelConfig {
  webhookUrl?: string;
  clientId?: string;
  clientSecret?: string;
  registeredWebhookBase?: Record<string, string>;
  accounts?: Array<{
    id?: string;
    domain?: string;
    webhookUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    clientId?: string;
    clientSecret?: string;
    enabled?: boolean;
    textChunkLimit?: number;
    bot?: Partial<BotConfig>;
    botId?: number;
    botCode?: string;
    dmPolicy?: 'open' | 'paired';
    configWrites?: boolean;
    dynamicAgentCreation?: DynamicAgentCreationConfig;
    /** Bitrix user ids allowed to run control commands; '*' = everyone. */
    commandUsers?: string[];
    /** Bitrix user ids allowed to talk to the bot; '*' = everyone; absent = everyone. */
    allowUsers?: string[];
    applicationToken?: string;
  }>;
  /** Channel-level default for accounts that do not set their own. */
  commandUsers?: string[];
  allowUsers?: string[];
  configWrites?: boolean;
  dynamicAgentCreation?: DynamicAgentCreationConfig;
}
