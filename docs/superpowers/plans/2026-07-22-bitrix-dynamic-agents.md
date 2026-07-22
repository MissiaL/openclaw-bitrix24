# Bitrix24 Dynamic Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in Feishu-style automatic per-user agents to the external Bitrix24 plugin so direct-message memory is isolated by Bitrix account and employee.

**Architecture:** A focused `dynamic-agent.ts` module owns configuration resolution, deterministic identities, safe workspace bootstrap, and the atomic `agents.list` plus `bindings` mutation. `inbound-dispatch.ts` uses `fromUserId` for direct routing, invokes the module before staging media or running the turn, re-resolves against fresh config, and fails closed whenever enabled isolation cannot be established. The implementation uses only injected `api.runtime` capabilities and Node APIs.

**Tech Stack:** TypeScript 6, Node.js 20+ filesystem/crypto APIs, Vitest 4, OpenClaw injected plugin runtime.

## Global Constraints

- Do not connect to or modify the customer server.
- Do not modify agent scripts, document generators, VAT logic, or DOCX/PDF templates.
- Do not import any `openclaw/*` module from the external plugin.
- Existing installations keep current behavior unless both `dynamicAgentCreation.enabled` and `configWrites` are enabled.
- Groups never create personal agents.
- Enabled isolation failures never fall back to the shared base agent.
- Direct routing uses `fromUserId`; reply delivery continues to use `dialogId`.
- Implement each behavior test-first and observe the expected red failure before production changes.

---

### Task 1: Configuration contracts and manifest schema

**Files:**
- Modify: `src/bitrix24/types.ts`
- Modify: `src/bitrix24/accounts.ts`
- Modify: `extensions/bitrix24/openclaw.plugin.json`
- Modify: `tests/unit/accounts.test.ts`
- Modify: `tests/unit/manifest.test.ts`

**Interfaces:**
- Produces: `DynamicAgentCreationConfig` with `enabled`, `sourceAgentId`, `workspaceTemplate`, `agentDirTemplate`, `bootstrapFiles`, and `maxAgents`.
- Produces: effective `AccountConfig.configWrites` and `AccountConfig.dynamicAgentCreation` after account-over-channel precedence.

- [ ] **Step 1: Write failing account-precedence tests**

Add tests that load one account with only channel defaults and a second account with explicit overrides, then assert the full account object replaces the channel object:

```ts
expect(manager.getAccount('inherited')?.configWrites).toBe(true);
expect(manager.getAccount('inherited')?.dynamicAgentCreation?.sourceAgentId).toBe('base');
expect(manager.getAccount('overridden')?.configWrites).toBe(false);
expect(manager.getAccount('overridden')?.dynamicAgentCreation).toEqual({
  enabled: true,
  sourceAgentId: 'legal',
});
```

- [ ] **Step 2: Run the focused account tests and verify RED**

Run: `npx vitest run tests/unit/accounts.test.ts`

Expected: assertions fail because `AccountConfig` does not expose dynamic-agent settings.

- [ ] **Step 3: Add typed configuration and precedence**

Define:

```ts
export interface DynamicAgentCreationConfig {
  enabled?: boolean;
  sourceAgentId?: string;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  bootstrapFiles?: string[];
  maxAgents?: number;
}
```

Add `configWrites` and `dynamicAgentCreation` to `AccountConfig`, both channel-level fields to `RawChannelConfig`, and both account-level fields to `RawChannelConfig.accounts[]`. In `AccountManager.loadFromConfig`, use `raw.configWrites ?? config.configWrites ?? false` and `raw.dynamicAgentCreation ?? config.dynamicAgentCreation` without partial object merging.

- [ ] **Step 4: Run account tests and verify GREEN**

Run: `npx vitest run tests/unit/accounts.test.ts`

Expected: all account tests pass.

- [ ] **Step 5: Write failing manifest contract tests**

Assert both schema copies contain identical `configWrites` and `dynamicAgentCreation` definitions at channel and account levels, with `enabled: false`, `maxAgents >= 1`, and relative bootstrap string items.

- [ ] **Step 6: Run manifest tests and verify RED**

Run: `npx vitest run tests/unit/manifest.test.ts`

Expected: the new properties are absent.

- [ ] **Step 7: Add the schema to both manifest copies**

Add the same schema object under `configSchema.properties` and `channelConfigs.bitrix24.schema.properties`, and the same two override properties under each `accounts.items.properties`. Require no fields globally so the feature remains opt-in; constrain `maxAgents` to an integer with minimum 1 and `bootstrapFiles` to an array of non-empty strings.

- [ ] **Step 8: Run focused tests and commit**

Run: `npx vitest run tests/unit/accounts.test.ts tests/unit/manifest.test.ts`

Expected: all focused tests pass.

Commit: `feat(bitrix24): add dynamic agent configuration`

---

### Task 2: Atomic dynamic-agent provisioning

**Files:**
- Create: `extensions/bitrix24/src/dynamic-agent.ts`
- Create: `tests/unit/dynamic-agent.test.ts`

**Interfaces:**
- Consumes: effective channel/account config from Task 1 and injected `runtime.config.current`, `runtime.config.mutateConfigFile`, and `runtime.channel.routing.resolveAgentRoute`.
- Produces: `maybeCreateDynamicAgent(params): Promise<DynamicAgentResult>` where result status is `not-applicable`, `ready`, or `denied`, and `ready` includes the fresh config plus resolved agent ID.
- Produces: `resolveDynamicAgentId(accountId, userId): string` for deterministic tests.

- [ ] **Step 1: Write failing identity and no-op tests**

Cover deterministic bounded IDs, different IDs for the same user in different accounts, disabled configuration, groups handled by the caller, an existing exact binding, and a route that does not target `sourceAgentId`.

```ts
expect(resolveDynamicAgentId('tkp', '403')).toMatch(/^bitrix24-tkp-[a-f0-9]{32}$/);
expect(resolveDynamicAgentId('tkp', '403')).not.toBe(resolveDynamicAgentId('lawyer', '403'));
```

- [ ] **Step 2: Run the new test file and verify RED**

Run: `npx vitest run tests/unit/dynamic-agent.test.ts`

Expected: module import fails because `dynamic-agent.ts` does not exist.

- [ ] **Step 3: Implement configuration resolution and preflight**

Implement helpers that normalize account IDs, resolve the full account override, find exact direct bindings, find `sourceAgentId` in `agents.list`, count dynamic direct bindings for one account, expand all three path placeholders, and classify disabled/manual/existing/denied outcomes. Read `runtime.config.current()` before deciding; never rely only on the ingress snapshot.

- [ ] **Step 4: Run identity and no-op tests and verify GREEN**

Run: `npx vitest run tests/unit/dynamic-agent.test.ts`

Expected: the initial cases pass without calling `mutateConfigFile`.

- [ ] **Step 5: Write failing provisioning and fail-closed tests**

Cover successful agent plus binding creation, `dmScope`, missing config writer, non-open policy, missing source agent, max limit, stale config, agent-without-binding recovery, mutation-lock rechecks, and two concurrent calls producing one agent and one binding.

- [ ] **Step 6: Run provisioning tests and verify RED**

Run: `npx vitest run tests/unit/dynamic-agent.test.ts`

Expected: successful provisioning assertions fail because no mutation/workspace implementation exists.

- [ ] **Step 7: Implement atomic config mutation**

Call the injected writer with:

```ts
await runtime.config.mutateConfigFile({
  base: 'runtime',
  afterWrite: { mode: 'auto' },
  mutate: async (draft: any) => {
    // Repeat settings, exact binding, source route, source agent and limit checks.
    // Create agent directories only when the deterministic agent is absent.
    // Append one exact binding with per-account-channel-peer dmScope.
    return { created, agentId };
  },
});
```

Use a private sentinel error to abort a stale mutation without committing. After a commit, return `runtime.config.current()` rather than a guessed draft.

- [ ] **Step 8: Write failing bootstrap security tests**

Use temporary source/destination workspaces and assert allowed files plus a generated `USER.md` are copied, while absolute paths, `..`, symlinks, `MEMORY.md`, `USER.md`, `memory/`, `out/`, and missing source-workspace cases are denied.

- [ ] **Step 9: Run bootstrap tests and verify RED**

Run: `npx vitest run tests/unit/dynamic-agent.test.ts`

Expected: safe bootstrap assertions fail because files are not yet copied or validated.

- [ ] **Step 10: Implement safe workspace bootstrap**

Resolve the source workspace from the configured source agent entry. Validate each requested file with `isAbsolute`, normalized segments, `lstat().isSymbolicLink()`, and `realpath` containment before copying. Reject protected names even if configured. Create a fresh `USER.md` containing only employee name, Bitrix user ID, and Bitrix account ID; do not log the name.

- [ ] **Step 11: Run all dynamic-agent tests and commit**

Run: `npx vitest run tests/unit/dynamic-agent.test.ts`

Expected: all dynamic-agent tests pass.

Commit: `feat(bitrix24): provision isolated user agents`

---

### Task 3: Direct-message routing integration

**Files:**
- Modify: `extensions/bitrix24/src/inbound-dispatch.ts`
- Modify: `tests/unit/inbound-dispatch.test.ts`

**Interfaces:**
- Consumes: `maybeCreateDynamicAgent` from Task 2.
- Produces: a turn resolved from the fresh config and `fromUserId`, while delivery still targets `dialogId`.

- [ ] **Step 1: Change the existing route test to the required direct peer and verify RED**

Change the assertion to:

```ts
expect(routeArgs.peer).toEqual({ kind: 'direct', id: '7' });
```

Run: `npx vitest run tests/unit/inbound-dispatch.test.ts`

Expected: fails with current peer `{ kind: 'direct', id: 'chat42' }`.

- [ ] **Step 2: Route direct messages by `fromUserId`**

Build one `peer` variable: groups use `dialogId`; direct messages use `String(msg.fromUserId)`. Keep `To`, `OriginatingTo`, typing, media delivery, and `sendTextMessage` on `msg.dialogId`.

- [ ] **Step 3: Run the focused routing test and verify GREEN**

Run: `npx vitest run tests/unit/inbound-dispatch.test.ts -t "resolves the agent route"`

Expected: the route uses user ID and the turn still delivers to the original dialog.

- [ ] **Step 4: Write failing creation, re-route, group, and denial tests**

Extend the fake runtime with `config.current` and an atomic mutation harness. Assert the first direct message creates and routes to its personal agent, a group never mutates, and a denied dynamic result sends one neutral error to `dialogId` without invoking `inbound.run`.

- [ ] **Step 5: Run integration tests and verify RED**

Run: `npx vitest run tests/unit/inbound-dispatch.test.ts`

Expected: dynamic creation/re-resolution assertions fail.

- [ ] **Step 6: Integrate dynamic provisioning before turn setup**

For direct messages, call `maybeCreateDynamicAgent` before resolving workspace, session store, media, or inbound context. On `ready`, replace the active config with the returned fresh config and resolve the route again. On `denied`, log account/user/reason, send `Временная ошибка персонального профиля. Попробуйте позже.`, and return. Pass the fresh config to workspace, store-path, context, and `resolveTurn`.

- [ ] **Step 7: Run inbound tests and commit**

Run: `npx vitest run tests/unit/inbound-dispatch.test.ts tests/unit/dynamic-agent.test.ts`

Expected: all focused tests pass.

Commit: `feat(bitrix24): route direct messages to personal agents`

---

### Task 4: Documentation and complete local verification

**Files:**
- Modify: `extensions/bitrix24/README.md`
- Modify: `docs/superpowers/specs/2026-07-22-bitrix-dynamic-agents-design.md` only if implementation names differ from the approved contract.

**Interfaces:**
- Consumes: final configuration shape and behavior from Tasks 1-3.
- Produces: operator-facing opt-in example and documented failure semantics without customer-specific deployment steps.

- [ ] **Step 1: Document the generic opt-in configuration**

Add a README section showing channel defaults and one account override. State that personal agents isolate memory, groups stay on the base route, bootstrap copies only allowlisted files, and enabled provisioning failures fail closed. Do not include customer hostnames, account IDs, document-generation rules, or rollout commands.

- [ ] **Step 2: Run the complete test suite**

Run: `npx vitest run`

Expected: zero failing tests.

- [ ] **Step 3: Run lint and build**

Run: `npm run lint && npm run build`

Expected: both commands exit 0.

- [ ] **Step 4: Verify external-plugin boundary and patch hygiene**

Run: `if rg -n "from ['\"]openclaw/|import\(['\"]openclaw/" extensions/bitrix24/src; then exit 1; fi`

Expected: no matches and exit 0.

Run: `git diff --check`

Expected: exit 0 with no output.

- [ ] **Step 5: Review scope and commit**

Run: `git status --short && git diff --stat && git diff --name-only HEAD~3..HEAD`

Expected: only plugin source, tests, manifest, README, and the two scoped design/plan documents are present; no server files, agent scripts, generators, VAT logic, or document templates are changed.

Commit: `docs(bitrix24): document isolated dynamic agents`
