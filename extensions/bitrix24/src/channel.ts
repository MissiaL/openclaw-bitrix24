import { AccountManager, type RawChannelConfig } from '../../../src/bitrix24/accounts.js';
import { registerBot, unregisterBot, updateBotEventUrls } from '../../../src/bitrix24/bot.js';
import { sendMessage } from '../../../src/bitrix24/send.js';
import { downloadFile } from '../../../src/bitrix24/files.js';
import type { IncomingMessage, MediaAttachment } from '../../../src/bitrix24/types.js';
import { getBitrix24Runtime } from './runtime.js';
import { persistConfigValue } from './persist.js';

/**
 * Bitrix24 Channel Plugin — implements the OpenClaw ChannelPlugin interface.
 *
 * Provides the same UX as Telegram and Slack channels:
 *   - One-command setup via CLI
 *   - Multi-account support
 *   - Bidirectional text + file messaging
 *   - Typing indicators
 */
export class Bitrix24Channel {
  private accountManager = new AccountManager();
  private messageCallback: ((accountId: string, msg: IncomingMessage) => void) | null = null;

  /**
   * Initialize from OpenClaw config.
   */
  configure(rawConfig: RawChannelConfig): void {
    this.accountManager.loadFromConfig(rawConfig);
  }

  // ── Account management ───────────────────────────────────────────────────

  listEnabledAccounts(): Array<{ id: string; domain: string }> {
    return this.accountManager.listEnabledAccounts().map((a) => ({
      id: a.id,
      domain: a.domain,
    }));
  }

  listAccountIds(): string[] {
    return this.accountManager.listAccountIds();
  }

  resolveDefaultAccountId(): string {
    return this.accountManager.resolveDefaultAccountId();
  }

  resolveAccount(id: string) {
    return this.accountManager.getAccount(id);
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  /**
   * Send a message from the agent to a Bitrix24 dialog.
   */
  async sendTextMessage(
    accountId: string,
    dialogId: string,
    text: string,
    media?: MediaAttachment[],
  ): Promise<void> {
    const account = this.accountManager.getAccount(accountId);
    if (!account || !account.botId || !account.bot.clientId) {
      throw new Error(`Account "${accountId}" not configured, bot not registered, or bot CLIENT_ID missing`);
    }

    const client = this.accountManager.getClient(accountId);
    await sendMessage(client, {
      botId: account.botId,
      botClientId: account.bot.clientId,
      dialogId,
      text,
      media,
    }, {
      textChunkLimit: account.textChunkLimit,
    });
  }

  /**
   * Register callback for incoming messages.
   */
  onMessage(callback: (accountId: string, msg: IncomingMessage) => void): void {
    this.messageCallback = callback;
  }

  /**
   * Called by webhook server when a message arrives.
   */
  handleIncomingMessage(accountId: string, msg: IncomingMessage): void {
    this.messageCallback?.(accountId, msg);
  }

  /**
   * Download a file attachment from an incoming message via
   * `imbot.v2.File.download` (see `FileAttachment` in types.ts — the id
   * comes from the defensive, UNVERIFIABLE inbound-file parser in
   * receive.ts; `fileName` is passed through when known so the returned
   * `MediaAttachment.mimeType` can be guessed correctly).
   */
  async downloadAttachment(
    accountId: string,
    fileId: string | number,
    fileName?: string,
  ): Promise<MediaAttachment> {
    const account = this.accountManager.getAccount(accountId);
    if (!account?.botId || !account.bot.clientId) {
      throw new Error(`Account "${accountId}" not configured, bot not registered, or bot CLIENT_ID missing`);
    }

    const client = this.accountManager.getClient(accountId);
    return downloadFile(client, {
      botId: account.botId,
      botToken: account.bot.clientId,
      fileId,
      fileName,
    });
  }

  /**
   * Set callback for persisting refreshed OAuth tokens.
   */
  setTokenRefreshCallback(
    cb: (accountId: string, tokens: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => void | Promise<void>,
  ): void {
    this.accountManager.setTokenRefreshCallback(cb);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start an account: register the bot and prepare for messaging.
   */
  async startupAccount(accountId: string): Promise<void> {
    const runtime = getBitrix24Runtime();
    const account = this.accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account "${accountId}" not found`);

    const client = this.accountManager.getClient(accountId);
    const base = runtime.webhookBaseUrl.replace(/\/$/, '');

    // Bot already registered: re-point event URLs if the public base changed.
    if (account.botId) {
      const registered = this.accountManager.getRegisteredWebhookBase(accountId)?.replace(/\/$/, '');
      if (registered !== base) {
        if (!account.bot.clientId) {
          runtime.logger.warn(`Bitrix24 public URL changed for "${accountId}" but bot CLIENT_ID is missing; webhook URL not updated`);
          return;
        }
        runtime.logger.info(`Bitrix24 public URL changed for "${accountId}" (${registered ?? 'unknown'} -> ${base}); updating bot webhook URL...`);
        await updateBotEventUrls(client, {
          botId: account.botId,
          botClientId: account.bot.clientId,
          accountId,
          webhookBaseUrl: base,
        });
        this.accountManager.setRegisteredWebhookBase(accountId, base);
        await persistConfigValue({
          mutateConfigFile: runtime.mutateConfigFile,
          logger: runtime.logger,
          segments: ['channels', 'bitrix24', 'registeredWebhookBase', accountId],
          value: base,
        });
      } else {
        runtime.logger.info(`Bitrix24 bot already registered for "${accountId}" (ID: ${account.botId})`);
      }
      return;
    }

    // Register bot
    runtime.logger.info(`Registering Bitrix24 bot for "${accountId}" on ${account.domain}...`);
    if (!account.bot.clientId) {
      throw new Error(`Account "${accountId}" bot CLIENT_ID is not configured`);
    }
    const { botId, botCode } = await registerBot(
      client,
      accountId,
      base,
      account.bot,
    );

    this.accountManager.setBotInfo(accountId, botId, botCode);
    this.accountManager.setRegisteredWebhookBase(accountId, base);
    await persistConfigValue({
      mutateConfigFile: runtime.mutateConfigFile,
      logger: runtime.logger,
      segments: ['channels', 'bitrix24', 'registeredWebhookBase', accountId],
      value: base,
    });
    runtime.logger.info(`Bitrix24 bot registered: ${botCode} (ID: ${botId})`);
  }

  /**
   * Stop an account: unregister the bot.
   */
  async logoutAccount(accountId: string): Promise<void> {
    const runtime = getBitrix24Runtime();
    const account = this.accountManager.getAccount(accountId);
    if (!account?.botId) return;
    if (!account.bot.clientId) {
      runtime.logger.warn(`Cannot unregister Bitrix24 bot for "${accountId}": bot CLIENT_ID is missing`);
      return;
    }

    try {
      const client = this.accountManager.getClient(accountId);
      await unregisterBot(client, account.botId, account.bot.clientId);
      runtime.logger.info(`Bitrix24 bot unregistered for "${accountId}"`);
    } catch (err) {
      runtime.logger.warn(`Failed to unregister bot for "${accountId}": ${err}`);
    }
  }

  /**
   * Check account health.
   */
  async probeAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
    return this.accountManager.probeAccount(accountId);
  }

  // ── Directory ────────────────────────────────────────────────────────────

  /**
   * Get the TOFU-pinned webhook authenticity token for an account, if any
   * has been captured yet. Read by `webhook-server.ts` and passed to
   * `verifyApplicationToken` (src/bitrix24/receive.ts) to authenticate
   * incoming events.
   *
   * Security rationale: the webhook route is registered with `auth: 'plugin'`
   * (no gateway token — Bitrix24 cannot send one), so without this check
   * anyone who learns the webhook URL could inject forged events. TOFU pins
   * the portal's `application_token` from the first real event and rejects
   * everything else (see `captureApplicationToken` below).
   */
  getApplicationToken(accountId: string): string | undefined {
    return this.accountManager.getApplicationToken(accountId);
  }

  /**
   * Trust-on-first-use (TOFU) capture: pin the portal's top-level
   * `auth.application_token` from the first accepted webhook event for this
   * account, both in memory (so subsequent events in this process are
   * verified immediately) and durably in config (so the pin survives a
   * gateway restart).
   *
   * `channels.bitrix24.accounts` is an array of account objects (see
   * `RawChannelConfig.accounts` in accounts.ts), so the persisted value must
   * be upserted into the matching element by `id` — the same shape used for
   * the OAuth-token upsert in index.ts, not the flat accountId-keyed map used
   * for `registeredWebhookBase`.
   *
   * Called synchronously from the webhook request handler
   * (webhook-server.ts), so the durable write is fire-and-forget: a
   * config-write failure must not delay or fail the webhook response, and
   * the in-memory pin (already applied above) already protects subsequent
   * events within this process regardless of persistence outcome.
   */
  captureApplicationToken(accountId: string, token: string): void {
    this.accountManager.setApplicationToken(accountId, token);

    const runtime = getBitrix24Runtime();
    if (typeof runtime.mutateConfigFile !== 'function') {
      runtime.logger.warn(
        `[bitrix24] host does not support durable config writes; application_token for "${accountId}" not persisted`,
      );
      return;
    }

    runtime.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate: (draft: any) => {
        const bitrix24 = (draft.channels ??= {}).bitrix24 ??= {};
        const accounts: any[] = (bitrix24.accounts ??= []);
        let account = accounts.find((a) => a?.id === accountId);
        if (!account) {
          account = { id: accountId };
          accounts.push(account);
        }
        account.applicationToken = token;
      },
    }).catch((err: unknown) => {
      runtime.logger.warn(
        `[bitrix24] failed to persist application_token for "${accountId}"; continuing without durable write: ${err}`,
      );
    });
  }

  /**
   * Cleanup.
   */
  destroy(): void {
    this.accountManager.destroy();
  }
}
