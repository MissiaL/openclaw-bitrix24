import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { bbCodeToMarkdown } from '../../../src/bitrix24/format.js';
import type { IncomingMessage } from '../../../src/bitrix24/types.js';
import type { Bitrix24Channel } from './channel.js';
import { maybeCreateDynamicAgent } from './dynamic-agent.js';
import { loadOutboundMedia } from './outbound-media.js';

/**
 * Wire the missing inbound -> agent path: registers `channel.onMessage(...)`
 * so a Bitrix24 webhook event (already parsed into `IncomingMessage`) reaches
 * the openclaw agent and any agent reply is delivered back to the same dialog.
 *
 * Modeled on the bundled webhook-bot channels (feishu / googlechat / line),
 * which are the closest analogs to Bitrix24. The full flow is:
 *   1. resolve the agent route via `runtime.channel.routing.resolveAgentRoute`
 *      (gives the concrete agentId + sessionKey — a hand-made route makes the
 *      reply pipeline no-op, so this step is load-bearing);
 *   2. resolve the session store path via `runtime.channel.session.resolveStorePath`;
 *   3. finalize the inbound context via `runtime.channel.reply.finalizeInboundContext`;
 *   4. run the turn via `runtime.channel.inbound.run({ adapter: { ingest, resolveTurn } })`,
 *      whose `delivery.deliver` sends the assembled reply back with `sendTextMessage`.
 *
 * Everything comes from the injected `api.runtime.channel.*` (typed `any`), so
 * there are no `openclaw/*` imports. Never let a shape mismatch crash the
 * webhook — the whole handler is wrapped in try/catch.
 *
 * NOTE: the openclaw logger does NOT do printf `%s` substitution; all
 * diagnostics use template literals.
 */
// Verbose diagnostics include user message content / reply bodies (PII from a
// live portal). OFF by default; enabled only when BITRIX24_DEBUG is set.
const debugPayloads = (): boolean => Boolean(process.env.BITRIX24_DEBUG);

/**
 * Download inbound Drive attachments and stage them as local temp files in
 * the host's standard inbound-media shape (`MediaPaths` + `MediaTypes` on the
 * finalized msg context — the same fields the bundled feishu channel sets).
 * Best-effort per file: a failed download logs a warning and is skipped, so
 * the turn degrades to text-only instead of dying.
 */
async function stageInboundMedia(
  api: any,
  channel: Bitrix24Channel,
  accountId: string,
  msg: IncomingMessage,
  workspaceDir?: string,
): Promise<{ MediaPaths: string[]; MediaTypes: string[] } | undefined> {
  if (!msg.files?.length) return undefined;
  if (!workspaceDir) {
    api.logger.warn(
      `[bitrix24] cannot stage inbound files for dialog=${msg.dialogId}: agent workspace unavailable`,
    );
    return undefined;
  }

  const paths: string[] = [];
  const types: string[] = [];
  let dir: string | undefined;
  const inboundRoot = join(workspaceDir, '.openclaw', 'media', 'inbound');
  for (const file of msg.files) {
    try {
      const media = await channel.downloadAttachment(accountId, file.id, file.name);
      // One fresh directory per message: file names can't collide across
      // messages, and the sanitized basename strips any path separators. Keep
      // it under the routed agent workspace so the host media sandbox permits
      // PDF/image/document tools to read the attachment.
      if (!dir) {
        await mkdir(inboundRoot, { recursive: true });
        dir = await mkdtemp(join(inboundRoot, 'bitrix24-'));
      }
      // Unicode-aware sanitize: \w is ASCII-only and would flatten Cyrillic
      // names to "_", losing the filename hint the model relies on.
      const safeName = basename(media.fileName || `file-${file.id}`).replace(
        /[^\p{L}\p{N}()._-]+/gu,
        '_',
      );
      const filePath = join(dir, `${file.id}-${safeName}`);
      await writeFile(filePath, media.buffer);
      paths.push(filePath);
      types.push(media.mimeType);
      api.logger.info(
        `[bitrix24] staged inbound file id=${file.id} name=${safeName} ` +
          `type=${media.mimeType} bytes=${media.buffer.length} -> ${filePath}`,
      );
    } catch (err) {
      api.logger.warn(
        `[bitrix24] failed to download inbound file id=${file.id} (dialog=${msg.dialogId}): ${String(err)} — continuing without it`,
      );
    }
  }
  return paths.length > 0 ? { MediaPaths: paths, MediaTypes: types } : undefined;
}

async function readAllowedOutboundMedia(
  filePath: string,
  allowedRoots: Array<string | undefined>,
): Promise<Buffer> {
  const fileRealPath = await realpath(filePath);
  for (const root of allowedRoots) {
    if (!root) continue;
    let rootRealPath: string;
    try {
      rootRealPath = await realpath(root);
    } catch {
      continue;
    }
    const rootRelativePath = relative(rootRealPath, fileRealPath);
    if (
      rootRelativePath !== '..' &&
      !rootRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(rootRelativePath)
    ) {
      return await readFile(fileRealPath);
    }
  }
  throw new Error(`outbound media is outside allowed outbound media roots: ${filePath}`);
}

export function wireInboundDispatch(api: any, channel: Bitrix24Channel): void {
  channel.onMessage(async (accountId: string, msg: IncomingMessage) => {
    try {
      const textDiag = debugPayloads()
        ? ` text=${JSON.stringify((msg.text ?? '').slice(0, 200))}`
        : '';
      api.logger.info(
        `[bitrix24] inbound message acct=${accountId} dialog=${msg.dialogId} ` +
          `from=${msg.fromUserId} chatType=${msg.chatType} len=${msg.text?.length ?? 0}${textDiag}`,
      );

      const rc = api.runtime?.channel;
      if (!rc?.inbound?.run || typeof rc.routing?.resolveAgentRoute !== 'function') {
        api.logger.warn(
          '[bitrix24] runtime.channel.inbound.run / routing.resolveAgentRoute unavailable — inbound not delivered to agent',
        );
        return;
      }

      const isGroup = msg.chatType === 'C';
      const peer = {
        kind: isGroup ? 'group' : 'direct',
        id: isGroup ? String(msg.dialogId) : String(msg.fromUserId),
      } as const;

      let activeConfig = api.config;
      if (!isGroup) {
        try {
          const dynamicResult = await maybeCreateDynamicAgent({
            cfg: activeConfig,
            runtime: api.runtime,
            accountId,
            userId: String(msg.fromUserId),
            senderName:
              [msg.fromUserName, msg.fromUserLastName].filter(Boolean).join(' ').trim() ||
              undefined,
            resolveAgentRoute: rc.routing.resolveAgentRoute,
            log: (message) => api.logger.info(`[bitrix24] ${message}`),
          });
          activeConfig = dynamicResult.updatedCfg;
          if (dynamicResult.status === 'denied') {
            api.logger.error(
              `[bitrix24] personal agent unavailable accountId=${accountId} ` +
                `userId=${msg.fromUserId} reason=${dynamicResult.reason}`,
            );
            await channel.sendTextMessage(
              accountId,
              msg.dialogId,
              'Временная ошибка персонального профиля. Попробуйте позже.',
            );
            return;
          }
        } catch (error) {
          api.logger.error(
            `[bitrix24] personal agent provisioning failed accountId=${accountId} ` +
              `userId=${msg.fromUserId} error=${String(error)}`,
          );
          await channel.sendTextMessage(
            accountId,
            msg.dialogId,
            'Временная ошибка персонального профиля. Попробуйте позже.',
          );
          return;
        }
      }

      // 1) Resolve the agent route (concrete agentId + sessionKey). This is what
      // makes the reply pipeline actually run the agent.
      const route = rc.routing.resolveAgentRoute({
        cfg: activeConfig,
        channel: 'bitrix24',
        accountId,
        peer,
      });
      const agentId = route?.agentId;
      const sessionKey = route?.sessionKey;
      const routeAccountId = route?.accountId ?? accountId;

      // 2) Session store path (host session recorder requires a non-empty one).
      const storePath =
        (typeof rc.session?.resolveStorePath === 'function'
          ? rc.session.resolveStorePath(activeConfig?.session?.store, { agentId })
          : activeConfig?.session?.store) || undefined;

      api.logger.info(
        `[bitrix24] route resolved agentId=${agentId} sessionKey=${sessionKey} ` +
          `matchedBy=${route?.matchedBy} storePath=${storePath ?? '(none)'}`,
      );

      // Inbound text is BB-code; the agent wants Markdown. (Outbound Markdown ->
      // BB-code happens inside sendTextMessage.)
      const body = bbCodeToMarkdown(msg.text ?? '');
      const senderName =
        [msg.fromUserName, msg.fromUserLastName].filter(Boolean).join(' ').trim() || undefined;

      // Stage inbound file attachments as local media for the agent turn.
      const workspaceDir = api.runtime?.agent?.resolveAgentWorkspaceDir?.(activeConfig, agentId);
      const stateDir = api.runtime?.state?.resolveStateDir?.(process.env);
      const outboundMediaRoot = stateDir ? join(stateDir, 'media', 'outbound') : undefined;
      const media = await stageInboundMedia(
        api,
        channel,
        routeAccountId,
        msg,
        workspaceDir,
      );

      // Remember this message so later REPLY_ID quotes can resolve it; a
      // file-only message is remembered by its staged file names.
      const rememberedText =
        body ||
        (media
          ? `[файл: ${media.MediaPaths.map((p) => p.split('/').pop()?.replace(/^\d+-/, '')).join(', ')}]`
          : '');
      if (rememberedText) {
        channel.rememberMessage(routeAccountId, String(msg.messageId), {
          text: rememberedText,
          sender: senderName,
        });
      }

      // Resolve a quoted message (params.REPLY_ID carries only the id) from
      // the channel's recent-message cache into the host-standard ReplyTo*
      // context fields (telegram pattern). A cache miss still sets ReplyToId
      // so the model knows a quote happened.
      const quoted = msg.replyToMessageId
        ? channel.recallMessage(routeAccountId, msg.replyToMessageId)
        : undefined;
      const replyCtx = msg.replyToMessageId
        ? {
            ReplyToId: msg.replyToMessageId,
            ...(quoted ? { ReplyToBody: quoted.text } : {}),
            ...(quoted?.sender ? { ReplyToSender: quoted.sender } : {}),
          }
        : {};
      if (msg.replyToMessageId) {
        api.logger.info(
          `[bitrix24] quote resolved replyTo=${msg.replyToMessageId} hit=${Boolean(quoted)}`,
        );
      }

      // Control-command authorization: only configured Bitrix user ids may
      // run /status, /new, /stop, /restart, ... ('*' = everyone). Default is
      // deny — the bot is reachable by every portal employee, and /restart
      // must not be. Without CommandAuthorized: true the host treats a
      // "/command" message as plain agent text.
      const commandUsers =
        typeof channel.getCommandUsers === 'function' ? channel.getCommandUsers(routeAccountId) : [];
      const commandAuthorized =
        commandUsers.includes('*') || commandUsers.includes(String(msg.fromUserId));

      // 3) Finalize inbound context.
      const rawCtx = {
        ...(media ?? {}),
        ...replyCtx,
        ...(commandAuthorized ? { CommandAuthorized: true } : {}),
        Body: body,
        RawBody: msg.text ?? '',
        CommandBody: body,
        From: `bitrix24:${msg.fromUserId}`,
        To: `bitrix24:${msg.dialogId}`,
        SessionKey: sessionKey,
        AccountId: routeAccountId,
        ChatType: isGroup ? 'group' : 'direct',
        ConversationLabel: msg.dialogId,
        SenderName: senderName,
        SenderId: String(msg.fromUserId),
        Provider: 'bitrix24',
        Surface: 'bitrix24',
        // Host maps MessageSid -> sourceMessageId and calls `.trim()`, so it MUST
        // be a string (Bitrix message ids arrive as numbers).
        MessageSid: String(msg.messageId),
        Timestamp: Date.now(),
        OriginatingChannel: 'bitrix24',
        OriginatingTo: `bitrix24:${msg.dialogId}`,
      };
      const ctxPayload =
        typeof rc.reply?.finalizeInboundContext === 'function'
          ? rc.reply.finalizeInboundContext(rawCtx)
          : rawCtx;

      if (debugPayloads()) {
        api.logger.info(
          `[bitrix24] ctxPayload=${JSON.stringify(ctxPayload).slice(0, 2000)}`,
        );
      }

      // Deliver the agent's reply back to the same Bitrix dialog. Send on the
      // final assembled block to avoid emitting partial streamed chunks as
      // separate messages.
      const hasMedia = (payload: any): boolean =>
        Boolean(payload?.mediaUrl) ||
        (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0);
      let mediaBlockDelivered = false;
      const deliver = async (payload: any, info?: any) => {
        try {
          const kind = info?.kind;
          const keys = payload && typeof payload === 'object' ? Object.keys(payload) : payload;
          const sample = debugPayloads() ? ` sample=${JSON.stringify(payload).slice(0, 400)}` : '';
          api.logger.info(
            `[bitrix24] delivery kind=${kind} payload keys=${JSON.stringify(keys)}${sample}`,
          );
          // The host's durable path intentionally handles final payloads only.
          // A MEDIA reply can be emitted as the sole assembled `block`, with no
          // later `final` lifecycle event. Deliver that file here immediately;
          // otherwise the completed turn ends silently.
          if (kind === 'block' && hasMedia(payload)) {
            const mediaUrls =
              Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0
                ? payload.mediaUrls
                : [payload.mediaUrl];
            const attachments = await Promise.all(
              mediaUrls.map((mediaUrl: unknown) =>
                loadOutboundMedia(String(mediaUrl), (filePath) =>
                  readAllowedOutboundMedia(filePath, [workspaceDir, outboundMediaRoot]),
                ),
              ),
            );
            const text = payload?.text ?? payload?.body ?? '';
            await channel.sendTextMessage(
              routeAccountId,
              msg.dialogId,
              text,
              attachments,
            );
            mediaBlockDelivered = true;
            api.logger.info(
              `[bitrix24] media reply delivered to dialog=${msg.dialogId} files=${attachments.length} (${String(text).length} chars)`,
            );
            return undefined;
          }
          // Only send the final consolidated reply (skip intermediate blocks).
          if (kind && kind !== 'final') return undefined;
          // Some providers emit a trailing final payload after the assembled
          // media block. The user-visible result was already sent above, so a
          // warning or duplicate final must not produce a second message.
          if (kind === 'final' && mediaBlockDelivered) {
            api.logger.info(
              `[bitrix24] final reply skipped after delivered media block (dialog=${msg.dialogId})`,
            );
            return undefined;
          }
          const text = payload?.text ?? payload?.body ?? '';
          if (!text) {
            api.logger.warn(`[bitrix24] final reply had no text (dialog=${msg.dialogId})`);
            return undefined;
          }
          await channel.sendTextMessage(routeAccountId, msg.dialogId, text);
          api.logger.info(
            `[bitrix24] reply delivered to dialog=${msg.dialogId} (${String(text).length} chars)`,
          );
        } catch (err) {
          api.logger.error(`[bitrix24] delivery to dialog=${msg.dialogId} failed: ${String(err)}`);
        }
        return undefined;
      };

      // 4) Run the inbound turn (feishu/googlechat pattern).
      api.logger.info(
        `[bitrix24] dispatch via inbound.run agentId=${agentId} session=${sessionKey} ` +
          `hasFinalize=${typeof rc.reply?.finalizeInboundContext === 'function'} ` +
          `hasBufferedDispatcher=${typeof rc.reply?.dispatchReplyWithBufferedBlockDispatcher === 'function'}`,
      );
      // Start typing at ingress, not only when the model emits its first reply
      // block. Tool-heavy turns can stay silent for many seconds before that
      // first block, which makes a healthy bot look dead in Bitrix24.
      const notifyTyping = async (duration: number, phase: 'keepalive' | 'stop') => {
        try {
          await channel.sendTypingIndicator(routeAccountId, msg.dialogId, { duration });
        } catch (err) {
          api.logger.warn(`[bitrix24] typing ${phase} failed: ${String(err)}`);
        }
      };
      await notifyTyping(10, 'keepalive');
      const typingTimer = setInterval(() => {
        void notifyTyping(10, 'keepalive');
      }, 8_000);
      typingTimer.unref?.();
      try {
        await rc.inbound.run({
          channel: 'bitrix24',
          accountId: routeAccountId,
          raw: msg,
        // Kernel stage tracing (ingest/record/dispatch/finalize start|done|error).
        // Without this the turn is a black box between "dispatch via inbound.run"
        // and "inbound.run returned" — exactly where the first live-debugging
        // round got stuck.
        log: (ev: any) => {
          const err = ev?.error ? ` error=${String(ev.error)}` : '';
          api.logger.info(
            `[bitrix24] turn stage=${ev?.stage} event=${ev?.event} msg=${ev?.messageId ?? ''} ` +
              `admission=${ev?.admission ?? ''}${ev?.reason ? ` reason=${ev.reason}` : ''}${err}`,
          );
        },
        adapter: {
          ingest: () => ({
            id: String(msg.messageId),
            timestamp: Date.now(),
            rawText: msg.text ?? '',
            textForAgent: body,
            textForCommands: body,
            raw: msg,
          }),
          resolveTurn: () => ({
            cfg: activeConfig,
            channel: 'bitrix24',
            accountId: routeAccountId,
            agentId,
            routeSessionKey: sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: rc.session?.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              rc.reply?.dispatchReplyWithBufferedBlockDispatcher,
            delivery: {
              // Let the host's durable outbound path handle generated files. It
              // applies the local-media sandbox and invokes this channel's
              // registered outbound.sendMedia adapter. Text-only replies retain
              // the legacy direct delivery below.
              durable: (payload: any) => {
                return hasMedia(payload) ? { to: msg.dialogId } : false;
              },
              deliver,
              onError: (err: unknown, info: unknown) => {
                api.logger.error(
                  `[bitrix24] delivery error info=${JSON.stringify(info)} err=${String(err)}`,
                );
              },
            },
            replyOptions: {},
            record: {
              onRecordError: (err: unknown) => {
                api.logger.warn(`[bitrix24] failed recording inbound session: ${String(err)}`);
              },
            },
          }),
          },
        });
      } finally {
        clearInterval(typingTimer);
        // The API has no cancel call; a one-second indicator replaces the
        // active keepalive and disappears immediately after the turn.
        await notifyTyping(1, 'stop');
      }
      api.logger.info(`[bitrix24] inbound.run returned for dialog=${msg.dialogId}`);
    } catch (err) {
      api.logger.error(`[bitrix24] inbound dispatch failed: ${String(err)}`);
    }
  });
}
