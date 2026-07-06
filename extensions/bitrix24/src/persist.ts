/**
 * Durable config persistence helper.
 *
 * The openclaw plugin API has no `api.persistConfig(...)` method — that call
 * was a phantom API that silently no-oped (see openclaw `src/plugins/types.ts`).
 * The real durable-write mechanism is `api.runtime.config.mutateConfigFile(...)`,
 * which mutates a draft of openclaw.json and lets the gateway decide how to
 * apply it (hot-reload/restart) via `afterWrite`.
 */

export type ConfigMutator = (params: {
  afterWrite: { mode: 'auto' } | { mode: 'none'; reason: string };
  mutate: (draft: any) => void;
}) => Promise<unknown>;

// Plugin durability writes (TOFU token, botId, registeredWebhookBase, OAuth
// tokens) update in-memory state immediately, so they only need to reach disk
// for the next restart — they must NOT trigger a gateway reload/restart, which
// would interrupt an in-flight agent turn. `mode: 'none'` writes without any
// restart/hot-reload.
export const DURABLE_AFTER_WRITE = {
  mode: 'none',
  reason: 'bitrix24 plugin durability write',
} as const;

/**
 * Set a value at a nested path (array of segments — dot-safe, so an
 * accountId containing '.' cannot corrupt the path) inside a config draft,
 * creating intermediate objects as needed.
 */
export function setConfigPath(draft: any, segments: string[], value: unknown): void {
  if (segments.length === 0) {
    throw new Error('setConfigPath: segments must not be empty');
  }

  let node = draft;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (typeof node[key] !== 'object' || node[key] === null) {
      node[key] = {};
    }
    node = node[key];
  }

  node[segments[segments.length - 1]] = value;
}

/**
 * Durably apply an arbitrary mutation to openclaw.json via the host's
 * mutateConfigFile. No-ops with a warning if the host doesn't expose it.
 *
 * Lower-level primitive underneath `persistConfigValue` — use this directly
 * when a single durable write needs to touch more than one shape (e.g. a
 * flat `segments` path AND an accounts-array upsert) so both land atomically
 * in one `mutateConfigFile` call instead of two.
 */
export async function persistConfigMutation(params: {
  mutateConfigFile: ConfigMutator | undefined;
  logger: { warn: (m: string) => void };
  description: string;
  mutate: (draft: any) => void;
}): Promise<void> {
  const { mutateConfigFile, logger, description, mutate } = params;

  if (!mutateConfigFile) {
    logger.warn(`[bitrix24] host does not support durable config writes; ${description} not persisted`);
    return;
  }

  await mutateConfigFile({ afterWrite: DURABLE_AFTER_WRITE, mutate });
}

/**
 * Durably persist a single value into openclaw.json via the host's
 * mutateConfigFile. No-ops with a warning if the host doesn't expose it.
 */
export async function persistConfigValue(params: {
  mutateConfigFile: ConfigMutator | undefined;
  logger: { warn: (m: string) => void };
  segments: string[];
  value: unknown;
}): Promise<void> {
  const { mutateConfigFile, logger, segments, value } = params;

  return persistConfigMutation({
    mutateConfigFile,
    logger,
    description: segments.join('.'),
    mutate: (draft) => setConfigPath(draft, segments, value),
  });
}

/**
 * Upsert fields into the matching element (by `id`) of the
 * `channels.bitrix24.accounts` array inside a config draft, creating the
 * element if it doesn't exist yet. `channels.bitrix24.accounts` is an array
 * of account objects (see `RawChannelConfig.accounts` in accounts.ts), so any
 * per-account durable write (OAuth tokens, `applicationToken`, `botId`/
 * `botCode`) must upsert into the matching element rather than write a flat
 * accountId-keyed map.
 */
export function upsertBitrix24Account(
  draft: any,
  accountId: string,
  fields: Record<string, unknown>,
): void {
  const bitrix24 = (draft.channels ??= {}).bitrix24 ??= {};
  const accounts: any[] = (bitrix24.accounts ??= []);
  let account = accounts.find((a: any) => a?.id === accountId);
  if (!account) {
    account = { id: accountId };
    accounts.push(account);
  }
  Object.assign(account, fields);
}
