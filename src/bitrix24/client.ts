import axios, { AxiosInstance } from 'axios';
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
  private http: AxiosInstance;
  private limiter: RateLimiter;
  private config: Bitrix24ClientConfig;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: Bitrix24ClientConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rateLimit ?? 2);

    const baseURL = this.resolveBaseURL();
    const timeout = config.timeout ?? 30000;

    this.http = axios.create({ baseURL, timeout });
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
   * Acquire a rate-limiter slot and POST once. Does not interpret the response —
   * callers decide how to handle `data.error` / thrown errors.
   */
  private async postOnce<T>(
    method: string,
    params: Record<string, any>,
  ): Promise<{ data: BitrixApiResponse<T> }> {
    await this.limiter.acquire();
    const authParams = this.getAuthParams();
    return this.http.post<BitrixApiResponse<T>>(`/${method}`, { ...params, ...authParams });
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

    const maxRetries = this.config.rateLimitMaxRetries ?? 3;
    const baseDelayMs = this.config.rateLimitBaseDelayMs ?? 1000;

    for (let attempt = 0; ; attempt++) {
      let response: { data: BitrixApiResponse<T> };
      try {
        response = await this.postOnce<T>(method, params);
      } catch (err) {
        if (isRateLimitHttpError(err) && attempt < maxRetries) {
          await this.sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
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
          await this.sleep(baseDelayMs * 2 ** attempt);
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
    await this.limiter.acquire();

    const authParams = this.getAuthParams();
    const url = authParams.auth
      ? `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}auth=${authParams.auth}`
      : downloadUrl;

    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      return toDownloadedFile(response);
    } catch (err) {
      if (this.canRefresh() && isAxiosAuthError(err)) {
        await this.forceRefresh();
        await this.limiter.acquire();

        const retryAuth = this.getAuthParams();
        const retryUrl = retryAuth.auth
          ? `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}auth=${retryAuth.auth}`
          : downloadUrl;
        const response = await axios.get(retryUrl, { responseType: 'arraybuffer', timeout: 60000 });
        return toDownloadedFile(response);
      }
      throw err;
    }
  }

  /**
   * Update OAuth tokens (after manual refresh).
   */
  updateTokens(accessToken: string, refreshToken?: string, expiresAt?: number): void {
    if (this.config.auth.type !== 'oauth') return;
    const oauth = this.config.auth as OAuthAuth;
    oauth.accessToken = accessToken;
    if (refreshToken) oauth.refreshToken = refreshToken;
    if (expiresAt !== undefined) oauth.expiresAt = expiresAt;
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
 * Normalize a file-download axios response: bytes plus the header-derived
 * filename (RFC 5987 `filename*=` preferred over plain `filename=`) and
 * content type (parameters like `; charset=binary` stripped).
 */
function toDownloadedFile(response: {
  data: ArrayBuffer | Buffer;
  headers?: Record<string, unknown>;
}): { buffer: Buffer; fileName?: string; contentType?: string } {
  const headers = response.headers ?? {};
  const rawType = headers['content-type'];
  const contentType =
    typeof rawType === 'string' && rawType.trim() !== ''
      ? rawType.split(';')[0].trim().toLowerCase()
      : undefined;

  let fileName: string | undefined;
  const disposition = headers['content-disposition'];
  if (typeof disposition === 'string') {
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (extended) {
      try {
        fileName = decodeURIComponent(extended[1].trim());
      } catch {
        // Malformed percent-encoding — fall through to the plain form.
      }
    }
    if (!fileName) {
      const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/.exec(disposition);
      const raw = plain?.[1] ?? plain?.[2];
      if (raw) fileName = raw.trim();
    }
  }

  return { buffer: Buffer.from(response.data as ArrayBuffer), fileName, contentType };
}

/**
 * Check if an axios error is a 401/403 auth error (for download retry).
 */
function isAxiosAuthError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as any).response;
    return resp?.status === 401 || resp?.status === 403;
  }
  return false;
}

/**
 * Check if an axios error is an HTTP 503 or 429, which Bitrix24 may return
 * on rate-limit exhaustion instead of a `data.error` payload. The docs
 * disagree on which status to expect (system-errors.html says 503 +
 * QUERY_LIMIT_EXCEEDED; the imbot.v2 limits table says 429) — handle both.
 */
function isRateLimitHttpError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as any).response;
    return resp?.status === 503 || resp?.status === 429;
  }
  return false;
}

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
