import type {
  Bitrix24ClientConfig,
  BitrixApiResponse,
  OAuthAuth,
} from './types.js';
import { refreshTokens, expiresAtFromResponse, isTokenExpired } from './oauth.js';

/**
 * Token-bucket rate limiter.
 * Serializes requests to stay within Bitrix24 rate limits (default 2 req/s).
 */
class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(reqPerSec: number) {
    this.maxTokens = reqPerSec;
    this.tokens = reqPerSec;
    this.refillInterval = 1000 / reqPerSec;
  }

  async acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      this.ensureRefill();
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.ensureRefill();
    });
  }

  private ensureRefill(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next();
      } else {
        this.tokens = Math.min(this.tokens + 1, this.maxTokens);
        if (this.tokens >= this.maxTokens && this.queue.length === 0) {
          clearInterval(this.timer!);
          this.timer = null;
        }
      }
    }, this.refillInterval);
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }
}

/** Error codes that indicate an expired or invalid OAuth token. */
const TOKEN_ERROR_CODES = ['expired_token', 'invalid_token', 'NO_AUTH_FOUND'];

/**
 * Error codes that indicate a Bitrix24 rate limit (leaky bucket) was exhausted.
 * See https://apidocs.bitrix24.ru/limits.html and .../system-errors.html
 */
const RATE_LIMIT_ERROR_CODES = ['QUERY_LIMIT_EXCEEDED', 'OVERLOAD_LIMIT', 'OPERATION_TIME_LIMIT'];

/**
 * Bitrix24 REST API client.
 * Supports both webhook URL and OAuth authentication.
 * Built-in rate limiting (token bucket, default 2 req/s).
 * Automatic OAuth token refresh with retry-once on token errors.
 */
export class Bitrix24Client {
  private baseURL: string;
  private limiter = new RateLimiter(2);
  private config: Bitrix24ClientConfig;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: Bitrix24ClientConfig) {
    this.config = config;
    this.baseURL = this.resolveBaseURL();
  }

  private resolveBaseURL(): string {
    const { auth, domain } = this.config;
    if (auth.type === 'webhook') {
      // Webhook URL already contains /rest/{userId}/{secret}/
      return auth.webhookUrl.replace(/\/$/, '');
    }
    return `https://${domain}/rest`;
  }

  private getAuthParams(): Record<string, string> {
    if (this.config.auth.type === 'oauth') {
      return { auth: (this.config.auth as OAuthAuth).accessToken };
    }
    // Webhook URLs don't need extra auth params — they're in the URL
    return {};
  }

  // ── OAuth refresh helpers ──────────────────────────────────────────────────

  private canRefresh(): boolean {
    if (this.config.auth.type !== 'oauth') return false;
    const oauth = this.config.auth as OAuthAuth;
    return !!(oauth.refreshToken && oauth.clientId && oauth.clientSecret);
  }

  /**
   * Proactive refresh: check expiresAt and refresh if within buffer window.
   * Coalesces concurrent calls into a single refresh request.
   */
  private async refreshIfNeeded(): Promise<void> {
    if (this.config.auth.type !== 'oauth') return;
    const oauth = this.config.auth as OAuthAuth;
    if (!isTokenExpired(oauth.expiresAt)) return;
    if (!this.canRefresh()) return;

    await this.doRefreshCoalesced(oauth);
  }

  /**
   * Forced refresh: used after a token error response.
   */
  private async forceRefresh(): Promise<void> {
    const oauth = this.config.auth as OAuthAuth;
    await this.doRefreshCoalesced(oauth);
  }

  /**
   * Coalesce concurrent refresh attempts into a single HTTP call.
   */
  private async doRefreshCoalesced(oauth: OAuthAuth): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }
    this.refreshPromise = this.doRefresh(oauth);
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(oauth: OAuthAuth): Promise<void> {
    const resp = await refreshTokens({
      refreshToken: oauth.refreshToken!,
      clientId: oauth.clientId!,
      clientSecret: oauth.clientSecret!,
    });

    const expiresAt = expiresAtFromResponse(resp.expires_in);

    // Update in-memory tokens
    oauth.accessToken = resp.access_token;
    oauth.refreshToken = resp.refresh_token;
    oauth.expiresAt = expiresAt;

    // Notify persistence callback
    await this.config.onTokenRefresh?.({
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresAt,
    });
  }

  // ── Request helpers ────────────────────────────────────────────────────────

  /**
   * Acquire a rate-limiter slot and POST once. Returns the HTTP status and the
   * parsed JSON body — Bitrix24 sends `{error, error_description}` bodies on
   * 4xx too, so callers decide how to handle `data.error`.
   */
  private async postOnce<T>(
    method: string,
    params: Record<string, any>,
  ): Promise<{ status: number; data: BitrixApiResponse<T> }> {
    await this.limiter.acquire();
    const res = await fetch(`${this.baseURL}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, ...this.getAuthParams() }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 503 || res.status === 429) throw new RateLimitHttpError(`HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as BitrixApiResponse<T>;
    if (!res.ok && !data.error) {
      throw new Error(`Bitrix24 HTTP ${res.status} [${method}]`);
    }
    return { status: res.status, data };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call any Bitrix24 REST API method.
   * Automatically refreshes OAuth tokens if expired (proactive + reactive).
   * Retries with exponential backoff on Bitrix24 rate-limit errors
   * (QUERY_LIMIT_EXCEEDED / OVERLOAD_LIMIT / OPERATION_TIME_LIMIT / HTTP 503 / HTTP 429),
   * independent of the OAuth token-refresh retry above.
   */
  async callMethod<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.refreshIfNeeded();

    const maxRetries = 3;
    const baseDelayMs = this.config.rateLimitBaseDelayMs ?? 1000;

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await this.sleep(baseDelayMs * 2 ** (attempt - 1));
      let response: { status: number; data: BitrixApiResponse<T> };
      try {
        response = await this.postOnce<T>(method, params);
      } catch (err) {
        if (err instanceof RateLimitHttpError && attempt < maxRetries) continue;
        throw err;
      }

      if (response.data.error) {
        // Reactive refresh: token expired between check and call.
        // This retry is separate from the rate-limit backoff loop — a single
        // retry-once, not attempt-indexed.
        if (TOKEN_ERROR_CODES.includes(response.data.error) && this.canRefresh()) {
          await this.forceRefresh();

          const retryResponse = await this.postOnce<T>(method, params);
          if (retryResponse.data.error) {
            throw new Bitrix24Error(
              retryResponse.data.error,
              retryResponse.data.error_description ?? '',
              method,
            );
          }
          return retryResponse.data.result;
        }

        if (RATE_LIMIT_ERROR_CODES.includes(response.data.error) && attempt < maxRetries) {
          continue;
        }

        throw new Bitrix24Error(
          response.data.error,
          response.data.error_description ?? '',
          method,
        );
      }

      return response.data.result;
    }
  }

  /**
   * Download a file from Bitrix24 by its download URL.
   * Automatically refreshes OAuth tokens if expired.
   *
   * Returns the response headers' filename/content-type when present — the
   * live inbound FILE_ID shape carries no metadata and imbot.v2.File.download
   * returns only a URL, so these headers are the only source of the real
   * file name and type.
   */
  async downloadFile(
    downloadUrl: string,
  ): Promise<{ buffer: Buffer; fileName?: string; contentType?: string }> {
    await this.refreshIfNeeded();

    const fetchOnce = async (): Promise<Response> => {
      await this.limiter.acquire();
      const { auth } = this.getAuthParams();
      const url = auth
        ? `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}auth=${auth}`
        : downloadUrl;
      return fetch(url, { signal: AbortSignal.timeout(60000) });
    };

    let res = await fetchOnce();
    if ((res.status === 401 || res.status === 403) && this.canRefresh()) {
      await this.forceRefresh();
      res = await fetchOnce();
    }
    if (!res.ok) throw new Error(`Bitrix24 file download failed: HTTP ${res.status}`);

    const rawType = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      fileName: fileNameFromDisposition(res.headers.get('content-disposition')),
      contentType: rawType || undefined,
    };
  }

  /**
   * Check if the client can reach the portal.
   */
  async probe(): Promise<{ ok: boolean; domain?: string; userId?: string; error?: string }> {
    try {
      const user = await this.callMethod<{
        ID: string;
        NAME: string;
        LAST_NAME: string;
      }>('user.current');
      return { ok: true, domain: this.config.domain, userId: user.ID };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Verify connection and check required scopes.
   * Uses app.info (doesn't require 'user' scope).
   */
  async verifyConnection(): Promise<{
    ok: boolean;
    domain?: string;
    scopes?: string[];
    missingScopes?: string[];
    error?: string;
  }> {
    const REQUIRED_SCOPES = ['imbot', 'im', 'disk'];

    try {
      const info = await this.callMethod<{ scope?: string[]; license?: string }>('app.info');
      const scopes = Array.isArray(info.scope) ? info.scope : [];
      const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

      return {
        ok: missing.length === 0,
        domain: this.config.domain,
        scopes,
        missingScopes: missing.length > 0 ? missing : undefined,
        error: missing.length > 0
          ? `Missing required scopes: ${missing.join(', ')}`
          : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  get domain(): string {
    return this.config.domain;
  }

  destroy(): void {
    this.limiter.destroy();
  }
}

/**
 * Extract the file name from a Content-Disposition header: RFC 5987
 * `filename*=UTF-8''...` preferred over the plain `filename=` form.
 */
export function fileNameFromDisposition(disposition: string | null | undefined): string | undefined {
  if (!disposition) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/.exec(disposition);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

/**
 * Bitrix24 may signal rate-limit exhaustion with HTTP 503 or 429 instead of a
 * `data.error` payload. The docs disagree on which status to expect
 * (system-errors.html says 503 + QUERY_LIMIT_EXCEEDED; the imbot.v2 limits
 * table says 429) — handle both.
 */
class RateLimitHttpError extends Error {}

/**
 * Typed Bitrix24 API error.
 */
export class Bitrix24Error extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly method: string,
  ) {
    super(`Bitrix24 API error [${method}]: ${code} — ${description}`);
    this.name = 'Bitrix24Error';
  }
}

/**
 * Create a Bitrix24Client from a webhook URL string.
 * Extracts domain automatically.
 */
export function createClientFromWebhook(webhookUrl: string): Bitrix24Client {
  const url = new URL(webhookUrl);
  const domain = url.hostname;

  return new Bitrix24Client({
    domain,
    auth: { type: 'webhook', webhookUrl },
  });
}
