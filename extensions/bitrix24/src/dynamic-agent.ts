import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type ResolveAgentRoute = (params: {
  cfg: any;
  channel: string;
  accountId: string;
  peer: { kind: 'direct'; id: string };
}) => any;

export type DynamicAgentResult =
  | { status: 'not-applicable'; updatedCfg: any }
  | { status: 'denied'; updatedCfg: any; reason: string }
  | {
      status: 'ready';
      updatedCfg: any;
      agentId: string;
      created: boolean;
    };

type EffectiveDynamicSettings = {
  configWrites: boolean;
  dmPolicy: string;
  dynamicAgentCreation?: {
    enabled?: boolean;
    sourceAgentId?: string;
    workspaceTemplate?: string;
    agentDirTemplate?: string;
    bootstrapFiles?: string[];
    maxAgents?: number;
  };
};

type MutationResult = { created: boolean; agentId: string };

class DynamicAgentMutationSkipped extends Error {
  constructor(readonly result: DynamicAgentResult) {
    super('dynamic agent mutation skipped');
  }
}

class DynamicAgentProvisioningError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const PROTECTED_BOOTSTRAP_ROOTS = new Set([
  '.openclaw',
  'memory',
  'out',
  'user.md',
  'memory.md',
]);

function accountSlug(accountId: string): string {
  const slug = accountId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12);
  return slug || 'default';
}

export function resolveDynamicAgentId(accountId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(accountId.trim().toLowerCase())
    .update('\0')
    .update(userId)
    .digest('hex')
    .slice(0, 32);
  return `bitrix24-${accountSlug(accountId)}-${digest}`;
}

function resolveSettings(cfg: any, accountId: string): EffectiveDynamicSettings {
  const channel = cfg?.channels?.bitrix24 ?? {};
  const account = Array.isArray(channel.accounts)
    ? channel.accounts.find((entry: any) => (entry?.id ?? 'default') === accountId)
    : undefined;
  return {
    configWrites: account?.configWrites ?? channel.configWrites ?? false,
    dmPolicy: account?.dmPolicy ?? 'open',
    dynamicAgentCreation: account?.dynamicAgentCreation ?? channel.dynamicAgentCreation,
  };
}

function hasAgent(cfg: any, agentId: string): boolean {
  return (cfg?.agents?.list ?? []).some((agent: any) => agent?.id === agentId);
}

function findAgent(cfg: any, agentId: string): any | undefined {
  return (cfg?.agents?.list ?? []).find((agent: any) => agent?.id === agentId);
}

function resolveSourceWorkspace(cfg: any, runtime: any, agentId: string): string | undefined {
  return (
    runtime?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId) ?? findAgent(cfg, agentId)?.workspace
  );
}

function findExactBinding(cfg: any, accountId: string, userId: string): any | undefined {
  return (cfg?.bindings ?? []).find(
    (binding: any) =>
      binding?.match?.channel === 'bitrix24' &&
      binding.match?.accountId === accountId &&
      binding.match?.peer?.kind === 'direct' &&
      String(binding.match.peer.id) === userId,
  );
}

function countDynamicAgents(cfg: any, accountId: string): number {
  const prefix = `bitrix24-${accountSlug(accountId)}-`;
  const ids = new Set<string>();
  for (const binding of cfg?.bindings ?? []) {
    if (
      binding?.match?.channel === 'bitrix24' &&
      binding.match?.accountId === accountId &&
      binding.match?.peer?.kind === 'direct' &&
      typeof binding.agentId === 'string' &&
      binding.agentId.startsWith(prefix)
    ) {
      ids.add(binding.agentId);
    }
  }
  return ids.size;
}

function resolveUserPath(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function expandTemplate(
  template: string,
  values: { accountId: string; userId: string; agentId: string },
): string {
  return resolveUserPath(
    template
      .split('{accountId}')
      .join(values.accountId)
      .split('{userId}')
      .join(values.userId)
      .split('{agentId}')
      .join(values.agentId),
  );
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function resolveBootstrapSources(
  sourceWorkspace: string,
  bootstrapFiles: string[],
): Promise<Array<{ relativePath: string; sourcePath: string }>> {
  const sourceRoot = await realpath(sourceWorkspace).catch(() => {
    throw new DynamicAgentProvisioningError('source-workspace-missing');
  });
  const resolvedFiles: Array<{ relativePath: string; sourcePath: string }> = [];
  for (const relativePath of bootstrapFiles) {
    const normalized = relativePath.replaceAll('\\', '/');
    const segments = normalized.split('/').filter(Boolean);
    if (
      !normalized ||
      isAbsolute(relativePath) ||
      segments.length === 0 ||
      segments.includes('..') ||
      PROTECTED_BOOTSTRAP_ROOTS.has(segments[0].toLowerCase())
    ) {
      throw new DynamicAgentProvisioningError('invalid-bootstrap-path');
    }
    const sourcePath = resolve(sourceRoot, ...segments);
    if (!isWithin(sourceRoot, sourcePath)) {
      throw new DynamicAgentProvisioningError('invalid-bootstrap-path');
    }
    const sourceStat = await lstat(sourcePath).catch(() => {
      throw new DynamicAgentProvisioningError('invalid-bootstrap-path');
    });
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new DynamicAgentProvisioningError('invalid-bootstrap-path');
    }
    const sourceRealPath = await realpath(sourcePath);
    if (!isWithin(sourceRoot, sourceRealPath)) {
      throw new DynamicAgentProvisioningError('invalid-bootstrap-path');
    }
    resolvedFiles.push({ relativePath: segments.join('/'), sourcePath: sourceRealPath });
  }
  return resolvedFiles;
}

function safeUserField(value: string | undefined): string {
  return (value ?? 'Unknown').replace(/[\r\n]+/g, ' ').trim() || 'Unknown';
}

async function bootstrapWorkspace(params: {
  workspace: string;
  agentDir: string;
  sourceWorkspace: string;
  bootstrapFiles: string[];
  accountId: string;
  userId: string;
  senderName?: string;
}): Promise<void> {
  const sources = await resolveBootstrapSources(params.sourceWorkspace, params.bootstrapFiles);
  await mkdir(params.workspace, { recursive: true });
  await mkdir(params.agentDir, { recursive: true });
  for (const source of sources) {
    const destination = join(params.workspace, source.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source.sourcePath, destination);
  }
  await writeFile(
    join(params.workspace, 'USER.md'),
    [
      '# Bitrix24 User',
      '',
      `- Name: ${safeUserField(params.senderName)}`,
      `- Bitrix user ID: ${safeUserField(params.userId)}`,
      `- Bitrix account ID: ${safeUserField(params.accountId)}`,
      '',
    ].join('\n'),
    { flag: 'wx' },
  );
}

function denied(updatedCfg: any, reason: string): DynamicAgentResult {
  return { status: 'denied', updatedCfg, reason };
}

function preflightReason(params: {
  cfg: any;
  settings: EffectiveDynamicSettings;
  accountId: string;
  dynamicAgentId: string;
}): string | undefined {
  const dynamic = params.settings.dynamicAgentCreation;
  if (!dynamic?.sourceAgentId || !findAgent(params.cfg, dynamic.sourceAgentId)) {
    return 'source-agent-missing';
  }
  if (!params.settings.configWrites) return 'config-writes-disabled';
  if (params.settings.dmPolicy !== 'open') return 'dm-policy-not-open';
  if (
    !hasAgent(params.cfg, params.dynamicAgentId) &&
    dynamic.maxAgents !== undefined &&
    countDynamicAgents(params.cfg, params.accountId) >= dynamic.maxAgents
  ) {
    return 'max-agents-reached';
  }
  return undefined;
}

function currentConfig(cfg: any, runtime: any): any {
  return typeof runtime?.config?.current === 'function' ? runtime.config.current() : cfg;
}

export async function maybeCreateDynamicAgent(params: {
  cfg: any;
  runtime: any;
  accountId: string;
  userId: string;
  senderName?: string;
  resolveAgentRoute: ResolveAgentRoute;
  log: (message: string) => void;
}): Promise<DynamicAgentResult> {
  const { accountId, userId, runtime, resolveAgentRoute } = params;
  const cfg = currentConfig(params.cfg, runtime);
  const settings = resolveSettings(cfg, accountId);
  if (!settings.dynamicAgentCreation?.enabled) {
    return { status: 'not-applicable', updatedCfg: cfg };
  }

  const dynamicAgentId = resolveDynamicAgentId(accountId, userId);
  const exactBinding = findExactBinding(cfg, accountId, userId);
  if (exactBinding) {
    return exactBinding.agentId === dynamicAgentId
      ? {
          status: 'ready',
          updatedCfg: cfg,
          agentId: dynamicAgentId,
          created: false,
        }
      : { status: 'not-applicable', updatedCfg: cfg };
  }
  const route = resolveAgentRoute({
    cfg,
    channel: 'bitrix24',
    accountId,
    peer: { kind: 'direct', id: userId },
  });
  if (route?.agentId === dynamicAgentId) {
    return {
      status: 'ready',
      updatedCfg: cfg,
      agentId: dynamicAgentId,
      created: false,
    };
  }
  if (route?.agentId !== settings.dynamicAgentCreation.sourceAgentId) {
    return { status: 'not-applicable', updatedCfg: cfg };
  }

  const reason = preflightReason({ cfg, settings, accountId, dynamicAgentId });
  if (reason) return denied(cfg, reason);
  if (typeof runtime?.config?.mutateConfigFile !== 'function') {
    return denied(cfg, 'config-writer-unavailable');
  }

  const sourceWorkspace = resolveSourceWorkspace(
    cfg,
    runtime,
    settings.dynamicAgentCreation.sourceAgentId!,
  );
  const bootstrapFiles = settings.dynamicAgentCreation.bootstrapFiles ?? [];
  if (bootstrapFiles.length > 0) {
    if (!sourceWorkspace) return denied(cfg, 'source-workspace-missing');
    try {
      await resolveBootstrapSources(sourceWorkspace, bootstrapFiles);
    } catch (error) {
      if (error instanceof DynamicAgentProvisioningError) {
        return denied(cfg, error.reason);
      }
      throw error;
    }
  }

  let mutationResult: MutationResult | undefined;
  try {
    const committed = await runtime.config.mutateConfigFile({
      base: 'runtime',
      afterWrite: { mode: 'auto' },
      mutate: async (draft: any): Promise<MutationResult> => {
        const lockedSettings = resolveSettings(draft, accountId);
        if (!lockedSettings.dynamicAgentCreation?.enabled) {
          throw new DynamicAgentMutationSkipped({
            status: 'not-applicable',
            updatedCfg: draft,
          });
        }
        const lockedRoute = resolveAgentRoute({
          cfg: draft,
          channel: 'bitrix24',
          accountId,
          peer: { kind: 'direct', id: userId },
        });
        const lockedExactBinding = findExactBinding(draft, accountId, userId);
        if (lockedExactBinding) {
          if (lockedExactBinding.agentId !== dynamicAgentId) {
            throw new DynamicAgentMutationSkipped({
              status: 'not-applicable',
              updatedCfg: draft,
            });
          }
          throw new DynamicAgentMutationSkipped({
            status: 'ready',
            updatedCfg: draft,
            agentId: dynamicAgentId,
            created: false,
          });
        }
        if (lockedRoute?.agentId !== lockedSettings.dynamicAgentCreation.sourceAgentId) {
          throw new DynamicAgentMutationSkipped({
            status: 'not-applicable',
            updatedCfg: draft,
          });
        }
        const lockedReason = preflightReason({
          cfg: draft,
          settings: lockedSettings,
          accountId,
          dynamicAgentId,
        });
        if (lockedReason) {
          throw new DynamicAgentMutationSkipped(denied(draft, lockedReason));
        }

        const dynamic = lockedSettings.dynamicAgentCreation;
        const agentExists = hasAgent(draft, dynamicAgentId);
        if (!agentExists) {
          const lockedSourceAgent = findAgent(draft, dynamic.sourceAgentId!);
          const lockedSourceWorkspace = resolveSourceWorkspace(
            draft,
            runtime,
            dynamic.sourceAgentId!,
          );
          const workspace = expandTemplate(
            dynamic.workspaceTemplate ?? '~/.openclaw/workspace-{agentId}',
            { accountId, userId, agentId: dynamicAgentId },
          );
          const agentDir = expandTemplate(
            dynamic.agentDirTemplate ?? '~/.openclaw/agents/{agentId}/agent',
            { accountId, userId, agentId: dynamicAgentId },
          );
          if (!lockedSourceWorkspace) {
            throw new DynamicAgentMutationSkipped(denied(draft, 'source-workspace-missing'));
          }
          try {
            await bootstrapWorkspace({
              workspace,
              agentDir,
              sourceWorkspace: lockedSourceWorkspace,
              bootstrapFiles: dynamic.bootstrapFiles ?? [],
              accountId,
              userId,
              senderName: params.senderName,
            });
          } catch (error) {
            if (error instanceof DynamicAgentProvisioningError) {
              throw new DynamicAgentMutationSkipped(denied(draft, error.reason));
            }
            throw error;
          }
          const sourceOverrides = structuredClone(lockedSourceAgent);
          delete sourceOverrides.id;
          delete sourceOverrides.default;
          delete sourceOverrides.workspace;
          delete sourceOverrides.agentDir;
          draft.agents = {
            ...draft.agents,
            list: [
              ...(draft.agents?.list ?? []),
              {
                ...structuredClone(sourceOverrides),
                id: dynamicAgentId,
                workspace,
                agentDir,
              },
            ],
          };
        }

        draft.bindings = [
          ...(draft.bindings ?? []),
          {
            agentId: dynamicAgentId,
            match: {
              channel: 'bitrix24',
              accountId,
              peer: { kind: 'direct', id: userId },
            },
            session: { dmScope: 'per-account-channel-peer' },
          },
        ];
        return { created: !agentExists, agentId: dynamicAgentId };
      },
    });
    mutationResult = committed?.result;
  } catch (error) {
    if (error instanceof DynamicAgentMutationSkipped) {
      return error.result;
    }
    throw error;
  }

  const updatedCfg = currentConfig(cfg, runtime);
  if (mutationResult?.created) {
    params.log(
      `dynamic agent created accountId=${accountId} userId=${userId} agentId=${dynamicAgentId}`,
    );
  }
  return {
    status: 'ready',
    updatedCfg,
    agentId: mutationResult?.agentId ?? dynamicAgentId,
    created: mutationResult?.created ?? false,
  };
}
