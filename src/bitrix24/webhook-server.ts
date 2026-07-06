import express, { Router, type Express, type Request, type Response } from 'express';
import type { Bitrix24MessageEvent, Bitrix24WelcomeEvent, Bitrix24BotDeleteEvent, IncomingMessage } from './types.js';
import { parseMessageEvent, parseWelcomeEvent, parseBotDeleteEvent, verifyApplicationToken } from './receive.js';

export interface WebhookHandlers {
  onMessage: (accountId: string, msg: IncomingMessage) => void;
  onWelcome?: (accountId: string, event: ReturnType<typeof parseWelcomeEvent>) => void;
  onBotDelete?: (accountId: string, event: ReturnType<typeof parseBotDeleteEvent>) => void;
  getApplicationToken?: (accountId: string) => string | undefined;
  /** Trust-on-first-use: pin a newly-seen application_token for an account. */
  captureApplicationToken?: (accountId: string, token: string) => void;
  /**
   * Whether `accountId` (the attacker-chosen `:accountId` URL segment) is a
   * known, configured account. When provided, events for an unrecognized
   * accountId are rejected with 404 BEFORE auth/parse/dispatch — an
   * unconfigured account has no TOFU-pinned token to check against, so
   * `getApplicationToken` would return `undefined` and every forged event
   * would otherwise be silently accepted. Optional for backward compatibility
   * with callers that don't wire account lookup.
   */
  hasAccount?: (accountId: string) => boolean;
}

/** Minimal shape needed to read `event` before dispatching to a typed parser. */
interface WebhookBody {
  event?: string;
  auth?: { application_token?: string };
}

/**
 * Authenticate an incoming event and, on trust-on-first-use, capture its
 * token. Applied to EVERY event type (message/welcome/delete) — a forged
 * event of any kind must be rejected once a token is pinned, and any event
 * type may be the first one Bitrix24 happens to deliver.
 *
 * Security rationale: this webhook route is registered with `auth: 'plugin'`
 * (no gateway token check — Bitrix24 cannot send one), so without this check
 * anyone who learns the URL could inject forged events. TOFU pins the
 * portal's `application_token` from the first real event for an account and
 * rejects everything else that doesn't match (spec §7: the token is "not
 * always present" — once pinned, an event that omits it is rejected, fail
 * closed).
 *
 * Order: if no token is stored yet, capture whatever token (if any) this
 * event carries and accept unconditionally (first-use trust). Otherwise,
 * require an exact match via `verifyApplicationToken`.
 */
function authenticateAndCapture(
  accountId: string,
  body: WebhookBody,
  handlers: WebhookHandlers,
): boolean {
  const stored = handlers.getApplicationToken?.(accountId);

  if (stored === undefined) {
    const token = body?.auth?.application_token;
    if (token) {
      handlers.captureApplicationToken?.(accountId, token);
    }
    return true;
  }

  return verifyApplicationToken(body, stored);
}

/**
 * Create an Express router for receiving Bitrix24 imbot.v2 webhook events.
 *
 * Route:
 *   POST /webhook/bitrix24/:accountId — single endpoint for ALL events.
 *   Bitrix24 posts every ONIMBOTV2* event here (registered via
 *   `imbot.v2.Bot.register`/`Bot.update` with `eventMode: webhook`); this
 *   dispatches by `req.body.event`:
 *     ONIMBOTV2MESSAGEADD -> onMessage
 *     ONIMBOTV2JOINCHAT   -> onWelcome
 *     ONIMBOTV2DELETE     -> onBotDelete
 *   Any other/unknown event is acknowledged with 200 {success:true} and
 *   otherwise ignored (e.g. ONIMBOTV2MESSAGEUPDATE/ONIMBOTV2MESSAGEDELETE,
 *   which this bot does not yet act on).
 */
export function createWebhookRouter(handlers: WebhookHandlers): Router {
  const router = Router();

  router.post('/webhook/bitrix24/:accountId', (req: Request, res: Response) => {
    try {
      const accountId = req.params.accountId as string;
      const body = req.body as WebhookBody;

      if (handlers.hasAccount && !handlers.hasAccount(accountId)) {
        res.status(404).json({ error: 'Unknown account' });
        return;
      }

      switch (body?.event) {
        case 'ONIMBOTV2MESSAGEADD': {
          if (!authenticateAndCapture(accountId, body, handlers)) {
            res.status(403).json({ error: 'Invalid application token' });
            return;
          }

          const msg = parseMessageEvent(body as unknown as Bitrix24MessageEvent);
          if (msg) {
            handlers.onMessage(accountId, msg);
          }
          break;
        }

        case 'ONIMBOTV2JOINCHAT': {
          if (!authenticateAndCapture(accountId, body, handlers)) {
            res.status(403).json({ error: 'Invalid application token' });
            return;
          }

          const event = parseWelcomeEvent(body as unknown as Bitrix24WelcomeEvent);
          if (event) {
            handlers.onWelcome?.(accountId, event);
          }
          break;
        }

        case 'ONIMBOTV2DELETE': {
          if (!authenticateAndCapture(accountId, body, handlers)) {
            res.status(403).json({ error: 'Invalid application token' });
            return;
          }

          const event = parseBotDeleteEvent(body as unknown as Bitrix24BotDeleteEvent);
          if (event) {
            handlers.onBotDelete?.(accountId, event);
          }
          break;
        }

        default:
          // Unknown/unhandled event — ack and ignore.
          break;
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[bitrix24-webhook] error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

/**
 * Create a self-contained Express app for Bitrix24 webhooks.
 *
 * Modern openclaw gateways pass raw Node req/res to plugin HTTP routes
 * without any body parsing, so the app must carry its own parsers.
 * Bitrix24 sends form-urlencoded with PHP-style nesting; extended mode
 * is required to reconstruct nested objects.
 */
export function createWebhookApp(handlers: WebhookHandlers): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createWebhookRouter(handlers));
  return app;
}
