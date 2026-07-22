import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  maybeCreateDynamicAgent,
  resolveDynamicAgentId,
} from '../../extensions/bitrix24/src/dynamic-agent.js';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'bitrix24-dynamic-agent-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function dynamicConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sourceAgentId: 'base-agent',
    workspaceTemplate: join(tempRoot, 'workspace-{accountId}-{userId}'),
    agentDirTemplate: join(tempRoot, 'agent-{agentId}'),
    bootstrapFiles: [],
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      bitrix24: {
        configWrites: true,
        dynamicAgentCreation: dynamicConfig(),
        accounts: [
          {
            id: 'tkp',
            webhookUrl: 'https://example.bitrix24.ru/rest/1/key/',
            dmPolicy: 'open',
          },
        ],
      },
    },
    agents: {
      list: [
        {
          id: 'base-agent',
          workspace: join(tempRoot, 'base-workspace'),
          agentDir: join(tempRoot, 'base-agent-dir'),
        },
      ],
    },
    bindings: [
      {
        agentId: 'base-agent',
        match: { channel: 'bitrix24', accountId: 'tkp' },
      },
    ],
    ...overrides,
  };
}

function makeHarness(initialCfg: any, mutationCfg?: any) {
  let currentCfg = structuredClone(initialCfg);
  const resolveAgentRoute = vi.fn(({ cfg, accountId, peer }: any) => {
    const exact = (cfg.bindings ?? []).find(
      (binding: any) =>
        binding.match?.channel === 'bitrix24' &&
        binding.match?.accountId === accountId &&
        binding.match?.peer?.kind === peer.kind &&
        String(binding.match.peer.id) === String(peer.id),
    );
    if (exact) {
      return { agentId: exact.agentId, matchedBy: 'binding.peer' };
    }
    const account = (cfg.bindings ?? []).find(
      (binding: any) =>
        binding.match?.channel === 'bitrix24' &&
        binding.match?.accountId === accountId &&
        binding.match?.peer === undefined,
    );
    return account
      ? { agentId: account.agentId, matchedBy: 'binding.account' }
      : { agentId: 'main', matchedBy: 'default' };
  });
  let mutationQueue = Promise.resolve();
  const mutateConfigFile = vi.fn((params: any) => {
    const operation = mutationQueue.then(async () => {
      const draft = structuredClone(mutationCfg ?? currentCfg);
      const result = await params.mutate(draft);
      currentCfg = draft;
      return { nextConfig: currentCfg, result };
    });
    mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  });
  return {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn((cfg: any, agentId: string) =>
          cfg.agents?.list?.find((agent: any) => agent.id === agentId)?.workspace,
        ),
      },
      config: {
        current: vi.fn(() => currentCfg),
        mutateConfigFile,
      },
    },
    resolveAgentRoute,
    mutateConfigFile,
    current: () => currentCfg,
  };
}

describe('resolveDynamicAgentId', () => {
  it('is deterministic, bounded, and scoped by account', () => {
    const first = resolveDynamicAgentId('TKP Team', '403');
    const repeated = resolveDynamicAgentId('TKP Team', '403');
    const otherAccount = resolveDynamicAgentId('Lawyer Team', '403');

    expect(first).toBe(repeated);
    expect(first).toMatch(/^bitrix24-tkp-team-[a-f0-9]{32}$/);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(otherAccount).not.toBe(first);
  });
});

describe('maybeCreateDynamicAgent preflight', () => {
  it('does nothing when dynamic creation is disabled', async () => {
    const cfg = makeConfig({
      channels: {
        bitrix24: {
          configWrites: true,
          dynamicAgentCreation: { ...dynamicConfig(), enabled: false },
          accounts: [{ id: 'tkp', dmPolicy: 'open' }],
        },
      },
    });
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      senderName: 'Ivan Petrov',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toEqual({ status: 'not-applicable', updatedCfg: cfg });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('returns an existing exact binding without mutating config', async () => {
    const cfg = makeConfig();
    const personalId = resolveDynamicAgentId('tkp', '403');
    cfg.agents.list.push({
      id: personalId,
      workspace: join(tempRoot, 'existing-workspace'),
      agentDir: join(tempRoot, 'existing-agent'),
    });
    cfg.bindings.push({
      agentId: personalId,
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
      session: { dmScope: 'per-account-channel-peer' },
    } as any);
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'ready',
      created: false,
      agentId: personalId,
      updatedCfg: cfg,
    });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('preserves a manual direct route that does not target sourceAgentId', async () => {
    const cfg = makeConfig();
    cfg.agents.list.push({ id: 'manual-agent' } as any);
    cfg.bindings.push({
      agentId: 'manual-agent',
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
    } as any);
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toEqual({ status: 'not-applicable', updatedCfg: cfg });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('preserves an exact manual binding even when it targets sourceAgentId', async () => {
    const cfg = makeConfig();
    cfg.bindings.push({
      agentId: 'base-agent',
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
    } as any);
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toEqual({ status: 'not-applicable', updatedCfg: cfg });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });
});

describe('maybeCreateDynamicAgent provisioning', () => {
  it('creates an isolated agent, exact binding, directories, and USER.md', async () => {
    const cfg = makeConfig();
    await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      senderName: 'Ivan Petrov',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    const agentId = resolveDynamicAgentId('tkp', '403');
    const workspace = join(tempRoot, 'workspace-tkp-403');
    const agentDir = join(tempRoot, `agent-${agentId}`);
    expect(result).toMatchObject({ status: 'ready', created: true, agentId });
    expect(harness.mutateConfigFile).toHaveBeenCalledWith({
      base: 'runtime',
      afterWrite: { mode: 'auto' },
      mutate: expect.any(Function),
    });
    expect(harness.current().agents.list).toContainEqual({ id: agentId, workspace, agentDir });
    expect(harness.current().bindings).toContainEqual({
      agentId,
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
      session: { dmScope: 'per-account-channel-peer' },
    });
    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect((await stat(agentDir)).isDirectory()).toBe(true);
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).toContain('Ivan Petrov');
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).toContain('403');
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).toContain('tkp');
  });

  it('resolves a source workspace through the injected runtime when the agent omits it', async () => {
    const cfg = makeConfig();
    delete cfg.agents.list[0].workspace;
    const sourceWorkspace = join(tempRoot, 'resolved-base-workspace');
    await mkdir(sourceWorkspace, { recursive: true });
    const harness = makeHarness(cfg);
    harness.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(sourceWorkspace);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result.status).toBe('ready');
    expect(harness.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(
      expect.any(Object),
      'base-agent',
    );
  });

  it('inherits functional source-agent overrides without inheriting identity or storage', async () => {
    const cfg = makeConfig();
    Object.assign(cfg.agents.list[0], {
      default: true,
      name: 'Tender Assistant',
      model: { primary: 'openai/gpt-test' },
      skills: ['tender-search'],
      tools: { deny: ['browser'] },
    });
    await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result.status).toBe('ready');
    const personal = harness.current().agents.list.find(
      (agent: any) => agent.id === resolveDynamicAgentId('tkp', '403'),
    );
    expect(personal).toMatchObject({
      name: 'Tender Assistant',
      model: { primary: 'openai/gpt-test' },
      skills: ['tender-search'],
      tools: { deny: ['browser'] },
    });
    expect(personal.default).toBeUndefined();
    expect(personal.workspace).not.toBe(cfg.agents.list[0].workspace);
    expect(personal.agentDir).not.toBe(cfg.agents.list[0].agentDir);
  });

  it('never deletes a pre-existing workspace when the config write fails', async () => {
    const cfg = makeConfig();
    const workspace = join(tempRoot, 'workspace-tkp-403');
    await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'keep.txt'), 'keep');
    const harness = makeHarness(cfg);
    harness.runtime.config.mutateConfigFile = vi.fn(async (params: any) => {
      const draft = structuredClone(cfg);
      await params.mutate(draft);
      throw new Error('config write failed');
    });

    await expect(
      maybeCreateDynamicAgent({
        cfg,
        runtime: harness.runtime,
        accountId: 'tkp',
        userId: '403',
        resolveAgentRoute: harness.resolveAgentRoute,
        log: vi.fn(),
      }),
    ).rejects.toThrow('config write failed');

    expect(await readFile(join(workspace, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it.each([
    ['config-writes-disabled', { configWrites: false }],
    ['dm-policy-not-open', { dmPolicy: 'paired' }],
  ])('fails closed with %s', async (reason, accountOverride) => {
    const cfg = makeConfig();
    Object.assign(cfg.channels.bitrix24.accounts[0], accountOverride);
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ status: 'denied', reason });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('fails closed when the configured source agent does not exist', async () => {
    const cfg = makeConfig();
    cfg.agents.list = [];
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ status: 'denied', reason: 'source-agent-missing' });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('enforces maxAgents per Bitrix24 account without shared fallback', async () => {
    const cfg = makeConfig();
    cfg.channels.bitrix24.dynamicAgentCreation.maxAgents = 1;
    const existingId = resolveDynamicAgentId('tkp', '402');
    cfg.agents.list.push({ id: existingId } as any);
    cfg.bindings.push({
      agentId: existingId,
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '402' },
      },
    } as any);
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ status: 'denied', reason: 'max-agents-reached' });
    expect(harness.mutateConfigFile).not.toHaveBeenCalled();
  });

  it('adds only a missing binding when the deterministic agent exists', async () => {
    const cfg = makeConfig();
    const agentId = resolveDynamicAgentId('tkp', '403');
    cfg.agents.list.push({
      id: agentId,
      workspace: join(tempRoot, 'existing-workspace'),
      agentDir: join(tempRoot, 'existing-agent'),
    });
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ status: 'ready', created: false, agentId });
    expect(harness.current().agents.list.filter((agent: any) => agent.id === agentId)).toHaveLength(1);
    expect(harness.current().bindings).toContainEqual({
      agentId,
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
      session: { dmScope: 'per-account-channel-peer' },
    });
  });

  it('uses fresh runtime configuration instead of a stale ingress snapshot', async () => {
    const staleCfg = makeConfig({ channels: { bitrix24: {} } });
    const currentCfg = makeConfig();
    await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
    const harness = makeHarness(currentCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: staleCfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result.status).toBe('ready');
    expect(harness.mutateConfigFile).toHaveBeenCalledOnce();
  });

  it('serializes concurrent first messages into one agent and one binding', async () => {
    const cfg = makeConfig();
    await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
    const harness = makeHarness(cfg);
    const params = {
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    };

    const results = await Promise.all([
      maybeCreateDynamicAgent(params),
      maybeCreateDynamicAgent(params),
    ]);

    const agentId = resolveDynamicAgentId('tkp', '403');
    expect(results.filter((result) => result.status === 'ready')).toHaveLength(2);
    expect(harness.current().agents.list.filter((agent: any) => agent.id === agentId)).toHaveLength(1);
    expect(
      harness.current().bindings.filter((binding: any) => binding.agentId === agentId),
    ).toHaveLength(1);
  });

  it('rechecks and preserves an exact manual binding added inside the mutation lock', async () => {
    const cfg = makeConfig();
    const mutationCfg = structuredClone(cfg);
    mutationCfg.bindings.push({
      agentId: 'base-agent',
      match: {
        channel: 'bitrix24',
        accountId: 'tkp',
        peer: { kind: 'direct', id: '403' },
      },
    });
    const harness = makeHarness(cfg, mutationCfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toEqual({ status: 'not-applicable', updatedCfg: mutationCfg });
    expect(harness.current()).toEqual(cfg);
  });
});

describe('dynamic agent workspace bootstrap', () => {
  it('copies only allowlisted bootstrap files and creates a fresh USER.md', async () => {
    const cfg = makeConfig();
    cfg.channels.bitrix24.dynamicAgentCreation.bootstrapFiles = ['AGENTS.md', 'SOUL.md'];
    const sourceWorkspace = join(tempRoot, 'base-workspace');
    await mkdir(join(sourceWorkspace, 'memory'), { recursive: true });
    await writeFile(join(sourceWorkspace, 'AGENTS.md'), 'shared agents');
    await writeFile(join(sourceWorkspace, 'SOUL.md'), 'shared soul');
    await writeFile(join(sourceWorkspace, 'MEMORY.md'), 'must not copy');
    await writeFile(join(sourceWorkspace, 'USER.md'), 'base user');
    await writeFile(join(sourceWorkspace, 'memory', 'secret.md'), 'must not copy');
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      senderName: 'Ivan Petrov',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result.status).toBe('ready');
    const workspace = join(tempRoot, 'workspace-tkp-403');
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('shared agents');
    expect(await readFile(join(workspace, 'SOUL.md'), 'utf8')).toBe('shared soul');
    await expect(stat(join(workspace, 'MEMORY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(workspace, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).not.toContain('base user');
  });

  it.each(['../secret.md', 'MEMORY.md', 'USER.md', '/tmp/absolute.md'])(
    'rejects protected or escaping bootstrap path %s',
    async (bootstrapFile) => {
      const cfg = makeConfig();
      cfg.channels.bitrix24.dynamicAgentCreation.bootstrapFiles = [bootstrapFile];
      await mkdir(join(tempRoot, 'base-workspace'), { recursive: true });
      const harness = makeHarness(cfg);

      const result = await maybeCreateDynamicAgent({
        cfg,
        runtime: harness.runtime,
        accountId: 'tkp',
        userId: '403',
        resolveAgentRoute: harness.resolveAgentRoute,
        log: vi.fn(),
      });

      expect(result).toMatchObject({ status: 'denied', reason: 'invalid-bootstrap-path' });
      expect(harness.current().bindings).toHaveLength(1);
    },
  );

  it('rejects a bootstrap symlink', async () => {
    const cfg = makeConfig();
    cfg.channels.bitrix24.dynamicAgentCreation.bootstrapFiles = ['AGENTS.md'];
    const sourceWorkspace = join(tempRoot, 'base-workspace');
    await mkdir(sourceWorkspace, { recursive: true });
    await writeFile(join(tempRoot, 'outside.md'), 'outside');
    await symlink(join(tempRoot, 'outside.md'), join(sourceWorkspace, 'AGENTS.md'));
    const harness = makeHarness(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime: harness.runtime,
      accountId: 'tkp',
      userId: '403',
      resolveAgentRoute: harness.resolveAgentRoute,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ status: 'denied', reason: 'invalid-bootstrap-path' });
    expect(harness.current().bindings).toHaveLength(1);
  });
});
