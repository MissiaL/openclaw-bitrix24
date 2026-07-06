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
  afterWrite: { mode: 'auto' };
  mutate: (draft: any) => void;
}) => Promise<unknown>;

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

  if (!mutateConfigFile) {
    const path = segments.join('.');
    logger.warn(`[bitrix24] host does not support durable config writes; ${path} not persisted`);
    return;
  }

  await mutateConfigFile({
    afterWrite: { mode: 'auto' },
    mutate: (draft) => setConfigPath(draft, segments, value),
  });
}
