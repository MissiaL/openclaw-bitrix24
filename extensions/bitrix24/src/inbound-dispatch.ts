import { bbCodeToMarkdown } from '../../../src/bitrix24/format.js';
import type { IncomingMessage } from '../../../src/bitrix24/types.js';
import type { Bitrix24Channel } from './channel.js';

/**
 * Wire the missing inbound -> agent path: registers `channel.onMessage(...)`
 * so a Bitrix24 webhook event (already parsed into `IncomingMessage`) reaches
 * the openclaw agent via `runtime.channel.inbound.dispatchReply`, and any
 * agent reply is delivered back to the same dialog.
 *
 * LIVE-TUNE (whole module): this is scaffolding. The `api.runtime.channel.*`
 * shapes below are modeled on the bundled IRC channel's `inbound.ts` (per
 * the task brief) — we cannot import it (hard constraint: no `openclaw/*`
 * imports), so every field/arg name is a best guess that must be verified
 * against the real host tomorrow. Every guess is logged so a human can
 * compare intended vs. actual shapes from production logs and adjust this
 * file. Never let a shape mismatch here crash the webhook — everything is
 * wrapped in try/catch.
 *
 * NOTE: the openclaw logger does NOT do printf-style `%s` substitution — it
 * prints the format string literally. All diagnostics here use template
 * literals so the real values show up in production logs.
 */
// Verbose diagnostics include user message content / reply bodies (PII from a
// live portal). They are OFF by default and only emitted when BITRIX24_DEBUG is
// set — enable it for a live-tuning session, then unset it in production.
const debugPayloads = (): boolean => Boolean(process.env.BITRIX24_DEBUG);

export function wireInboundDispatch(api: any, channel: Bitrix24Channel): void {
  channel.onMessage(async (accountId: string, msg: IncomingMessage) => {
    try {
      // Entry log: structural fields always; message content only under debug.
      const textDiag = debugPayloads()
        ? ` text=${JSON.stringify((msg.text ?? '').slice(0, 200))}`
        : '';
      api.logger.info(
        `[bitrix24] inbound message acct=${accountId} dialog=${msg.dialogId} ` +
          `from=${msg.fromUserId} chatType=${msg.chatType} len=${msg.text?.length ?? 0}${textDiag}`,
      );

      const rc = api.runtime?.channel;
      if (!rc?.inbound?.dispatchReply) {
        api.logger.warn(
          '[bitrix24] runtime.channel.inbound.dispatchReply unavailable — inbound not delivered to agent',
        );
        return;
      }

      // Inbound text from Bitrix24 arrives as BB-code; the agent expects
      // Markdown. (Outbound Markdown -> BB-code conversion already happens
      // inside `channel.sendTextMessage` — untouched here.)
      const body = bbCodeToMarkdown(msg.text ?? '');

      // LIVE-TUNE: IRC resolves a route (agentId/sessionKey/storePath) via an
      // SDK helper we cannot import. Instead we derive a stable session key
      // from account + dialog, and leave agentId/storePath undefined so the
      // host falls back to its own defaults. Verify tomorrow whether the
      // host actually defaults these when absent, or whether it needs an
      // explicit agentId.
      const sessionKey = `bitrix24:${accountId}:${msg.dialogId}`;
      const agentId = undefined;
      const storePath = undefined;
      api.logger.info(
        `[bitrix24] LIVE-TUNE: agentId/storePath left undefined (sessionKey=${sessionKey}) — host expected to resolve defaults`,
      );

      const senderName =
        [msg.fromUserName, msg.fromUserLastName].filter(Boolean).join(' ').trim() || undefined;

      // LIVE-TUNE: raw context fields mirrored from IRC's finalizeInboundContext
      // call. Field names/values (esp. ChatType's expected enum, and whether
      // Timestamp should be the event's own timestamp vs. wall-clock "now" —
      // IncomingMessage carries no inbound timestamp) need confirming against
      // the real host tomorrow.
      const rawCtx = {
        Body: body,
        RawBody: msg.text ?? '',
        CommandBody: body,
        From: `bitrix24:${msg.fromUserId}`,
        To: `bitrix24:${msg.dialogId}`,
        SessionKey: sessionKey,
        AccountId: accountId,
        ChatType: msg.chatType === 'C' ? 'group' : 'direct',
        ConversationLabel: msg.dialogId,
        SenderName: senderName,
        SenderId: String(msg.fromUserId),
        Provider: 'bitrix24',
        Surface: 'bitrix24',
        MessageSid: msg.messageId,
        Timestamp: Date.now(),
        OriginatingChannel: 'bitrix24',
        OriginatingTo: `bitrix24:${msg.dialogId}`,
      };

      // Defensive: only call finalizeInboundContext if the host actually
      // exposes it — fall back to the raw object otherwise so a missing
      // helper never blocks delivery.
      const ctxPayload =
        typeof rc.reply?.finalizeInboundContext === 'function'
          ? rc.reply.finalizeInboundContext(rawCtx)
          : rawCtx;

      const dispatchArgs = {
        cfg: api.config,
        channel: 'bitrix24',
        accountId,
        agentId,
        routeSessionKey: sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: rc.session?.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher: rc.reply?.dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          // LIVE-TUNE: the real delivery payload shape is unknown offline.
          // Defensive default per brief: try `payload.text`, then
          // `payload.body`, else empty. Log the actual keys seen in
          // production so this can be tightened tomorrow.
          deliver: async (payload: any) => {
            try {
              const keys =
                payload && typeof payload === 'object' ? Object.keys(payload) : payload;
              const sample = debugPayloads()
                ? ` sample=${JSON.stringify(payload).slice(0, 400)}`
                : '';
              api.logger.info(
                `[bitrix24] LIVE-TUNE delivery payload keys=${JSON.stringify(keys)}${sample}`,
              );
              const text = payload?.text ?? payload?.body ?? '';
              if (!text) {
                api.logger.warn(
                  `[bitrix24] delivery payload had no text/body to send (dialog=${msg.dialogId})`,
                );
                return;
              }
              await channel.sendTextMessage(accountId, msg.dialogId, text);
              api.logger.info(
                `[bitrix24] reply delivered to dialog=${msg.dialogId} (${String(text).length} chars)`,
              );
            } catch (err) {
              api.logger.error(
                `[bitrix24] delivery to dialog=${msg.dialogId} failed: ${String(err)}`,
              );
            }
          },
          onError: (err: unknown, info: unknown) => {
            api.logger.error(
              `[bitrix24] dispatchReply delivery error info=${JSON.stringify(info)} err=${String(err)}`,
            );
          },
        },
        replyPipeline: {},
        replyOptions: {},
        record: {
          onRecordError: (err: unknown) => {
            api.logger.warn(`[bitrix24] failed recording inbound session: ${String(err)}`);
          },
        },
      };

      // Log the full dispatch args (functions elided) before dispatch — the
      // key diagnostic for tomorrow's live tuning. Contains message content
      // (ctxPayload.Body), so gate it behind BITRIX24_DEBUG.
      if (debugPayloads()) {
        api.logger.info(
          `[bitrix24] LIVE-TUNE dispatchReply args=${JSON.stringify(
            dispatchArgs,
            (_key, value) => (typeof value === 'function' ? '[fn]' : value),
          ).slice(0, 4000)}`,
        );
      } else {
        api.logger.info(
          `[bitrix24] LIVE-TUNE dispatchReply sessionKey=${sessionKey} ` +
            `hasFinalize=${typeof rc.reply?.finalizeInboundContext === 'function'} ` +
            `hasRecord=${typeof rc.session?.recordInboundSession === 'function'} ` +
            `hasBufferedDispatcher=${typeof rc.reply?.dispatchReplyWithBufferedBlockDispatcher === 'function'}`,
        );
      }

      await rc.inbound.dispatchReply(dispatchArgs);
      api.logger.info(`[bitrix24] dispatchReply returned for dialog=${msg.dialogId}`);
    } catch (err) {
      api.logger.error(`[bitrix24] inbound dispatch failed: ${String(err)}`);
    }
  });
}
