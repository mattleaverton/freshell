# Option C Terminal Attach Viewport + Create/Attach Decoupling Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix terminal restore/refresh scroll corruption by ensuring replay cannot start before server-applied geometry, and converge the protocol to explicit `create -> attach` with no create-time auto-attach/replay contract.

**Architecture:** Use a bounded two-phase rollout. Phase A (compatibility) keeps legacy safety while new clients opt into split mode via `attachOnCreate:false` after reading `ready.capabilities`; phase A preserves old-client behavior and avoids hard breaks for viewport-less attaches by applying a concrete server geometry before replay. Phase B (cleanup, in this same plan) removes create-time auto-attach and `sendCreatedAndAttach` entirely once objective gates are met, making Option C the only contract. Hidden panes use a geometry-gated deferred attach state so replay never starts until concrete dimensions are known and applied server-side.

**Tech Stack:** TypeScript, React 18, xterm.js, Node/Express, WebSocket (`ws`), Zod protocol validation, Vitest (`vitest.config.ts` for client/jsdom; `vitest.server.config.ts` for server/node).

**Process Note:** The execution handoff section is intentionally omitted in this document to match the orchestrator rule for this planning thread; reviewers should treat this omission as deliberate.

---

## Phase A Compatibility Matrix (Required Behavior)

- `Old client + New server`: Must remain legacy-safe. New server auto-attaches by default when client does not opt into split mode.
- `New client + Old server`: Must remain legacy-safe. New client must detect missing `ready.capabilities.createAttachSplitV1` and stay in legacy create path (no explicit attach-after-created).
- `New client + New server`: Must use split mode (`create` sends `attachOnCreate:false`; explicit attach with viewport).
- `Old client + Old server`: Unchanged.

## Phase B Final State (Option C Contract)

- `terminal.create` only returns `terminal.created`; it never attaches or replays.
- `terminal.attach` is the only replay ingress.
- `sendCreatedAndAttach` and all create-time auto-attach branches are removed.
- Duplicate/reuse/idempotent create paths also return `terminal.created` only.

### Negotiation Model (Authoritative)

- Server -> client negotiation only: `ready.capabilities`.
- Phase A client -> server selection: `terminal.create.attachOnCreate`.
- Phase B: selection is removed; server is explicit-only and treats `attachOnCreate` as compatibility-noop.
- Server does **not** infer split support from hello capabilities.
- Client hello payload must remain unchanged for split flags (no `createAttachSplitV1`/`attachViewportV1` in hello), preventing contradictory two-way gating.

### Capability Decision Rules (Phase-Specific, Reconnect-Safe)

- Phase A (`compat`): when `ready` has not arrived yet, capability state is `unknown`; client defaults to legacy create (`attachOnCreate` omitted).
- Phase B (`explicit-only`): when `ready` has not arrived yet, client MUST NOT emit `terminal.create`; it queues create intents in `preReadyCreateQueue` and flushes only after `ready`.
- Capability state is updated only on `ready`.
- Per-pane create mode is latched per `createRequestId` at send time (`legacy` or `split`) so reconnect/downgrade/upgrade does not mutate in-flight semantics.
- In Phase B, each sent create must register `pendingCreateLifecycle[requestId]`. On `terminal.created`, client must either send exactly one viewport attach immediately, or transition to deferred `waiting_for_geometry` with guaranteed attach on visibility.
- On reconnect in Phase B, `pendingCreateLifecycle` is replayed deterministically: if `terminalId` is known and attach generation is incomplete, send exactly one new `terminal.attach` with viewport after `ready`; if `terminalId` is unknown, await `terminal.created` and then attach.

### Anti-regression invariants

- No `created`-without-attach dead-end in any matrix cell.
- No duplicate replay churn caused by both auto-attach and explicit attach in skew windows.
- Hidden-pane create/restore cannot replay before concrete geometry is applied server-side.
- In split mode, replay must not start until server performs a resize call for that attach generation.

### Chunk 6 Migration Barrier (Operationally Enforceable)

Chunk 6 cannot start until all of the following pass:

1. Telemetry gate is implemented and tested:
   - Server records rolling protocol counters:
     - `legacyAutoAttachCreates14d`
     - `legacyClientIds14d`
     - `splitCreates14d`
   - Server exposes `GET /api/admin/protocol-migration-status` returning those fields plus `windowDays`.
2. Gate checker command exists and is green against production snapshot:
   - `npm run protocol:migration:gate`
   - Command exits non-zero unless:
     - `legacyAutoAttachCreates14d === 0`
     - `legacyClientIds14d === 0`
     - `splitCreates14d >= 100` (minimum sample floor to avoid false-zero interpretation)
3. Two-window stability requirement:
   - Gate checker passes in two consecutive daily snapshots (24h apart), each covering the same 14-day rolling window policy.
4. Merge barrier:
   - Any PR/commit containing Chunk 6 code removal must include successful output from `npm run protocol:migration:gate`.
   - If this artifact is absent or failing, plan status remains incomplete by definition.

---

## File Structure Map

- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Create: `server/protocol-migration-gate.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/index.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `package.json`
- Create: `scripts/check-option-c-migration-gate.mjs`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Create: `test/server/protocol-migration-gate.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`

---

## Chunk 1: Protocol + One-Way Capability Negotiation

### Task 1: Add failing protocol tests for split capability and attach viewport validation

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `shared/ws-protocol.ts`

- [ ] **Step 1: Add failing tests first**

```ts
it('ready advertises terminal split capabilities', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const ready = await waitForMessage(ws, (m) => m.type === 'ready')
  expect(ready.capabilities).toMatchObject({
    createAttachSplitV1: true,
    attachViewportV1: true,
  })
  await close()
})

it('terminal.attach rejects partial viewport payload (cols only)', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const terminalId = await createTerminal(ws, 'partial-viewport-create')
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 120 }))
  const err = await waitForMessage(ws, (m) => m.type === 'error')
  expect(err.code).toBe('INVALID_MESSAGE')
  await close()
})

it('terminal.attach accepts paired viewport payload', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const terminalId = await createTerminal(ws, 'paired-viewport-create')
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 120, rows: 40, sinceSeq: 0 }))
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)
  expect(ready.terminalId).toBe(terminalId)
  await close()
})
```

- [ ] **Step 2: Run server protocol tests and verify RED**

Run: `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: FAIL on missing `ready.capabilities` and partial viewport validation.

- [ ] **Step 3: Implement protocol schema/types**

**File:** `shared/ws-protocol.ts`

```ts
export const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  protocolVersion: z.literal(WS_PROTOCOL_VERSION),
  capabilities: z.object({
    sessionsPatchV1: z.boolean().optional(),
    sessionsPaginationV1: z.boolean().optional(),
    uiScreenshotV1: z.boolean().optional(),
  }).optional(),
  client: z.object({
    mobile: z.boolean().optional(),
  }).optional(),
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
})

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi']).default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  restore: z.boolean().optional(),
  tabId: z.string().min(1).optional(),
  paneId: z.string().min(1).optional(),
  attachOnCreate: z.boolean().optional(),
})

export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  attachRequestId: z.string().min(1).optional(),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(2).max(500).optional(),
}).superRefine((msg, ctx) => {
  const hasCols = typeof msg.cols === 'number'
  const hasRows = typeof msg.rows === 'number'
  if (hasCols !== hasRows) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal.attach requires both cols and rows when viewport is provided' })
  }
})

export type ReadyMessage = {
  type: 'ready'
  timestamp: string
  serverInstanceId?: string
  capabilities?: {
    createAttachSplitV1?: boolean
    attachViewportV1?: boolean
  }
}
```

- [ ] **Step 4: Implement server `ready.capabilities` emission**

**File:** `server/ws-handler.ts`

```ts
this.send(ws, {
  type: 'ready',
  timestamp: nowIso(),
  serverInstanceId: this.serverInstanceId,
  capabilities: {
    createAttachSplitV1: true,
    attachViewportV1: true,
  },
})
```

- [ ] **Step 5: Re-run server protocol tests (GREEN)**

Run: `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts test/server/ws-protocol.test.ts
git commit -m "feat(protocol): add create/attach split capabilities and attach viewport validation"
```

---

## Chunk 2: Server Dual-Mode Create/Attach (No Stuck, No Dup Churn)

### Task 2: Add failing server tests for mixed-version behavior and split semantics

**Files:**
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

- [ ] **Step 1: Write failing tests first**

```ts
it('legacy client path: terminal.create auto-attaches when attachOnCreate is omitted', async () => {
  const { ws, close } = await createAuthenticatedConnection()

  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'legacy-auto', mode: 'shell' }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'legacy-auto')
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)

  expect(ready.terminalId).toBe(created.terminalId)
  await close()
})

it('split path request: terminal.create with attachOnCreate:false does not auto-attach', async () => {
  const { ws, close } = await createAuthenticatedConnection()

  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId: 'split-no-auto',
    mode: 'shell',
    attachOnCreate: false,
  }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-no-auto')
  const msgs = await collectMessages(ws, 150)
  const autoReadySeen = msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)

  expect(autoReadySeen).toBe(false)
  await close()
})

it('split-capable attach applies resize before replay', async () => {
  const { ws, close } = await createAuthenticatedConnection()

  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-attach', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-attach')
  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId: created.terminalId,
    sinceSeq: 0,
    cols: 111,
    rows: 37,
    attachRequestId: 'attach-split-1',
  }))

  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)
  expect(registry.resizeCalls).toContainEqual({ terminalId: created.terminalId, cols: 111, rows: 37 })
  expect(ready.attachRequestId).toBe('attach-split-1')
  await close()
})

it('reused codex/claude create in split mode returns created only until explicit attach', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId: 'reuse-split-1',
    mode: 'codex',
    resumeSessionId: CODEX_SESSION_ID,
    attachOnCreate: false,
  }))

  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'reuse-split-1')
  const preAttachMsgs = await collectMessages(ws, 150)
  expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40 }))
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)
  expect(ready.terminalId).toBe(created.terminalId)
  await close()
})

it('split-mode duplicate requestId is idempotent without duplicate attach.ready churn', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'dup-split-1', mode: 'shell', attachOnCreate: false }))
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'dup-split-1', mode: 'shell', attachOnCreate: false }))

  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'dup-split-1')
  const msgs = await collectMessages(ws, 200)
  const createdCount = msgs.filter((m) => m.type === 'terminal.created' && m.requestId === 'dup-split-1').length + 1
  const autoReadyCount = msgs.filter((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId).length
  expect(createdCount).toBe(1)
  expect(autoReadyCount).toBe(0)

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40, attachRequestId: 'dup-split-attach' }))
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'dup-split-attach')
  expect(ready.terminalId).toBe(created.terminalId)
  await close()
})

it('reuse helper paths honor split mode in both pre-config and post-config idempotency checks', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const createCases = [
    { requestId: 'reuse-codex-existingId', mode: 'codex', resumeSessionId: CODEX_SESSION_ID },
    { requestId: 'reuse-claude-existingAfterConfig', mode: 'claude', resumeSessionId: CLAUDE_SESSION_ID },
  ] as const

  for (const c of createCases) {
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId: c.requestId,
      mode: c.mode,
      resumeSessionId: c.resumeSessionId,
      attachOnCreate: false,
    }))
    const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === c.requestId)
    const preAttachMsgs = await collectMessages(ws, 150)
    expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

    const attachRequestId = `attach-${c.requestId}`
    ws.send(JSON.stringify({
      type: 'terminal.attach',
      terminalId: created.terminalId,
      sinceSeq: 0,
      cols: 120,
      rows: 40,
      attachRequestId,
    }))
    const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === attachRequestId)
    expect(ready.terminalId).toBe(created.terminalId)
    const postAttachMsgs = await collectMessages(ws, 150)
    expect(postAttachMsgs.filter((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === attachRequestId)).toHaveLength(0)
  }

  await close()
})

it('split-mode attach retry with same attachRequestId is idempotent and keeps resize-before-replay order', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-attach-retry', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-attach-retry')

  const ordered: string[] = []
  registry.onResize = () => ordered.push('resize')
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'terminal.attach.ready') ordered.push('ready')
    if (msg.type === 'terminal.output') ordered.push('output')
  })

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40, attachRequestId: 'retry-1' }))
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40, attachRequestId: 'retry-1' }))

  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'retry-1')
  expect(ready.terminalId).toBe(created.terminalId)
  registry.simulateOutput(created.terminalId, 'retry-seed')
  await waitForMessage(ws, (m) => m.type === 'terminal.output' && m.terminalId === created.terminalId)
  const msgs = await collectMessages(ws, 200)
  const duplicateReadyCount = msgs.filter((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'retry-1').length
  expect(duplicateReadyCount).toBe(0)
  expect(ordered.indexOf('ready')).toBeGreaterThan(ordered.indexOf('resize'))
  expect(ordered.indexOf('output')).toBeGreaterThan(ordered.indexOf('ready'))
  await close()
})

it('split attach without viewport remains compatibility-safe and still enforces resize-before-replay', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-missing-vp', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-missing-vp')

  const ordered: string[] = []
  registry.onResize = () => ordered.push('resize')
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'terminal.attach.ready') ordered.push('ready')
    if (msg.type === 'terminal.output') ordered.push('output')
  })

  registry.simulateOutput(created.terminalId, 'seed-split-missing-vp')
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0 }))
  await waitForMessage(ws, (m) => m.type === 'terminal.output' && m.terminalId === created.terminalId)
  expect(ordered.indexOf('resize')).toBeGreaterThanOrEqual(0)
  expect(ordered.indexOf('ready')).toBeGreaterThan(ordered.indexOf('resize'))
  expect(ordered.indexOf('output')).toBeGreaterThan(ordered.indexOf('ready'))
  await close()
})

it('split restore attach ordering: resize happens before attach.ready and replay output', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-restore-order', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-restore-order')

  registry.simulateOutput(created.terminalId, 'seed-1')
  registry.simulateOutput(created.terminalId, 'seed-2')

  const ordered: string[] = []
  registry.onResize = () => ordered.push('resize')
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'terminal.attach.ready') ordered.push('ready')
    if (msg.type === 'terminal.output') ordered.push('output')
  })

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40 }))
  await waitForMessage(ws, (m) => m.type === 'terminal.output' && m.terminalId === created.terminalId)

  expect(ordered.indexOf('resize')).toBeGreaterThanOrEqual(0)
  expect(ordered.indexOf('ready')).toBeGreaterThan(ordered.indexOf('resize'))
  expect(ordered.indexOf('output')).toBeGreaterThan(ordered.indexOf('ready'))
  await close()
})

it('split reconnect ordering: transport reconnect resize happens before attach.ready and replay delta', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-reconnect-order', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-reconnect-order')
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0, cols: 120, rows: 40 }))
  await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)
  registry.simulateOutput(created.terminalId, 'after-initial')
  const last = await waitForMessage(ws, (m) => m.type === 'terminal.output' && m.terminalId === created.terminalId)
  const lastSeq = last.seqEnd
  await close()

  const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
  const ordered: string[] = []
  registry.onResize = () => ordered.push('resize')
  ws2.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'terminal.attach.ready') ordered.push('ready')
    if (msg.type === 'terminal.output') ordered.push('output')
  })

  ws2.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId: created.terminalId,
    sinceSeq: lastSeq,
    cols: 120,
    rows: 40,
    attachRequestId: 'transport-reconnect-1',
  }))
  registry.simulateOutput(created.terminalId, 'after-reconnect')
  await waitForMessage(ws2, (m) => m.type === 'terminal.output' && m.terminalId === created.terminalId && String(m.data).includes('after-reconnect'))

  expect(ordered.indexOf('ready')).toBeGreaterThan(ordered.indexOf('resize'))
  expect(ordered.indexOf('output')).toBeGreaterThan(ordered.indexOf('ready'))
  await close2()
})
```

Add these harness hooks in `test/server/ws-edge-cases.test.ts` fake registry to make ordering assertions executable:

```ts
class FakeRegistry extends EventEmitter {
  onResize?: (terminalId: string, cols: number, rows: number) => void

  resize(terminalId: string, cols: number, rows: number) {
    const rec = this.records.get(terminalId)
    if (!rec || rec.status !== 'running') return false
    this.resizeCalls.push({ terminalId, cols, rows })
    this.onResize?.(terminalId, cols, rows)
    return true
  }
}
```

Add explicit branch-targeted split tests (not table-driven only) so reviewers can map each behavior to one branch:

- `test/server/ws-terminal-create-reuse-running-codex.test.ts`
  - `existingId branch + attachOnCreate:false => created only, zero auto attach.ready, explicit attach required`
  - `canonical reuse branch + attachOnCreate:false => created only, explicit attach emits one attach.ready`
- `test/server/ws-terminal-create-reuse-running-claude.test.ts`
  - `existingAfterConfig branch + attachOnCreate:false => created only, zero auto attach.ready`
  - `duplicate requestId in split mode => one created, no duplicate replay churn`

- [ ] **Step 2: Run server suites and verify RED**

Run:
`npx vitest run test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts --config vitest.server.config.ts`
Expected: FAIL because current server still auto-attaches unconditionally.

- [ ] **Step 3: Implement server-side mode selection logic**

**File:** `server/ws-handler.ts`

```ts
function shouldAutoAttachOnCreate(msg: { attachOnCreate?: boolean }): boolean {
  // One-way negotiation model:
  // client decides via attachOnCreate from ready.capabilities.
  return msg.attachOnCreate !== false
}
```

Add handler-level split tracking:

```ts
private splitAttachTerminalIds = new Set<string>()
```

- [ ] **Step 4: Implement split create behavior without removing legacy path**

**File:** `server/ws-handler.ts`

```ts
const autoAttach = shouldAutoAttachOnCreate(m)

async function sendCreateResult(opts: {
  ws: LiveWebSocket
  requestId: string
  terminalId: string
  createdAt: number
  effectiveResumeSessionId?: string
  autoAttach: boolean
}) {
  if (opts.autoAttach) {
    const attached = await this.terminalStreamBroker.sendCreatedAndAttach(opts.ws, {
      requestId: opts.requestId,
      terminalId: opts.terminalId,
      createdAt: opts.createdAt,
      effectiveResumeSessionId: opts.effectiveResumeSessionId,
    })
    if (attached) state.attachedTerminalIds.add(opts.terminalId)
    return
  }

  this.splitAttachTerminalIds.add(opts.terminalId)
  this.send(opts.ws, {
    type: 'terminal.created',
    requestId: opts.requestId,
    terminalId: opts.terminalId,
    createdAt: opts.createdAt,
    ...(opts.effectiveResumeSessionId ? { effectiveResumeSessionId: opts.effectiveResumeSessionId } : {}),
  })
}

// Use sendCreateResult() for ALL create return paths:
// - fresh create
// - existingId idempotency
// - existingAfterConfigId idempotency
// - canonical session reuse (codex/claude)
await sendCreateResult({
  ws,
  requestId: m.requestId,
  terminalId: record.terminalId,
  createdAt: record.createdAt,
  effectiveResumeSessionId,
  autoAttach,
})
```

- [ ] **Step 5: Implement attach viewport-then-replay ordering**

**File:** `server/ws-handler.ts`

```ts
const splitAttach = this.splitAttachTerminalIds.has(m.terminalId)
const hasViewport = typeof m.cols === 'number' && typeof m.rows === 'number'

const record = this.registry.get(m.terminalId)
if (!record) {
  this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
  return
}

// Compatibility behavior:
// - split attach with viewport: use caller viewport
// - split attach without viewport: fallback to record.cols/rows (legacy-safe skew path)
// - legacy attach: keep existing behavior
const resizeCols = hasViewport ? m.cols! : (splitAttach ? record.cols : undefined)
const resizeRows = hasViewport ? m.rows! : (splitAttach ? record.rows : undefined)

if (typeof resizeCols === 'number' && typeof resizeRows === 'number') {
  const resized = this.registry.resize(m.terminalId, resizeCols, resizeRows)
  if (!resized) {
    this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
    return
  }
}

const attached = await this.terminalStreamBroker.attach(ws, m.terminalId, m.sinceSeq, m.attachRequestId)
```

- [ ] **Step 6: Add explicit backward-compat guard assertions**

- Keep `sendCreatedAndAttach` path for legacy clients in this rollout.
- Do not remove auto-attach helper in this phase.
- Keep `splitAttachTerminalIds` entries until terminal exits/killed; remove in terminal exit/kill paths to avoid stale IDs.

- [ ] **Step 7: Re-run server suites (GREEN)**

Run:
`npx vitest run test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/ws-handler.ts test/server/ws-edge-cases.test.ts \
  test/server/ws-terminal-create-reuse-running-claude.test.ts \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/server/ws-terminal-stream-v2-replay.test.ts

git commit -m "feat(server): add dual-mode create/attach flow with viewport-before-replay attach"
```

---

## Chunk 3: Client Skew Handling + Hidden-Pane Geometry Gate

### Task 3: Add failing client unit/e2e tests for capability-gated split mode and hidden deferred attach

**Files:**
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

- [ ] **Step 1: Add failing ws-client capability tests**

```ts
it('hello payload does not advertise split flags (one-way negotiation)', async () => {
  const c = new WsClient('ws://example/ws')
  const p = c.connect()
  MockWebSocket.instances[0]._open()

  const hello = JSON.parse(MockWebSocket.instances[0].sent[0])
  expect(hello.type).toBe('hello')
  expect(hello.capabilities?.createAttachSplitV1).toBeUndefined()
  expect(hello.capabilities?.attachViewportV1).toBeUndefined()

  MockWebSocket.instances[0]._message({ type: 'ready' })
  await p
})

it('stores ready.capabilities and exposes split support helpers', async () => {
  const c = new WsClient('ws://example/ws')
  const p = c.connect()
  MockWebSocket.instances[0]._open()
  MockWebSocket.instances[0]._message({
    type: 'ready',
    capabilities: { createAttachSplitV1: true, attachViewportV1: true },
  })
  await p
  expect(c.supportsCreateAttachSplitV1()).toBe(true)
  expect(c.supportsAttachViewportV1()).toBe(true)
})

it('defaults capabilities to false when server does not advertise them', async () => {
  const c = new WsClient('ws://example/ws')
  const p = c.connect()
  MockWebSocket.instances[0]._open()
  MockWebSocket.instances[0]._message({ type: 'ready' })
  await p
  expect(c.supportsCreateAttachSplitV1()).toBe(false)
  expect(c.supportsAttachViewportV1()).toBe(false)
})

it('connect-time queued create resolves mode after ready (no stale unknown state)', async () => {
  const c = new WsClient('ws://example/ws')
  c.send({ type: 'terminal.create', requestId: 'queued-1', mode: 'shell', attachOnCreate: false } as any)
  const p = c.connect()
  MockWebSocket.instances[0]._open()
  MockWebSocket.instances[0]._message({ type: 'ready', capabilities: { createAttachSplitV1: true, attachViewportV1: true } })
  await p
  const flushed = MockWebSocket.instances[0].sent.map((x) => JSON.parse(x))
  expect(flushed.some((m) => m.type === 'terminal.create' && m.requestId === 'queued-1' && m.attachOnCreate === false)).toBe(true)
})

it('connect failure then ready flush sends queued create exactly once', async () => {
  const c = new WsClient('ws://example/ws')
  c.send({ type: 'terminal.create', requestId: 'queued-fail-then-ready', mode: 'shell' } as any)

  const p1 = c.connect()
  MockWebSocket.instances[0]._open()
  MockWebSocket.instances[0]._close(1006, 'before-ready')
  await expect(p1).rejects.toThrow()

  const p2 = c.connect()
  MockWebSocket.instances[1]._open()
  MockWebSocket.instances[1]._message({ type: 'ready', capabilities: { createAttachSplitV1: true, attachViewportV1: true } })
  await p2

  const sent = MockWebSocket.instances[1].sent.map((x) => JSON.parse(x))
  expect(sent.filter((m) => m.type === 'terminal.create' && m.requestId === 'queued-fail-then-ready')).toHaveLength(1)
})

it('capabilities reset to unknown/false on close and refresh on next ready', async () => {
  const c = new WsClient('ws://example/ws')
  const p1 = c.connect()
  MockWebSocket.instances[0]._open()
  MockWebSocket.instances[0]._message({ type: 'ready', capabilities: { createAttachSplitV1: true, attachViewportV1: true } })
  await p1
  expect(c.supportsCreateAttachSplitV1()).toBe(true)

  MockWebSocket.instances[0]._close(1006, 'reconnect')
  const p2 = c.connect()
  MockWebSocket.instances[1]._open()
  MockWebSocket.instances[1]._message({ type: 'ready', capabilities: { createAttachSplitV1: false, attachViewportV1: false } })
  await p2
  expect(c.supportsCreateAttachSplitV1()).toBe(false)
  expect(c.supportsAttachViewportV1()).toBe(false)
})
```

- [ ] **Step 2: Add failing TerminalView lifecycle tests**

Before these tests, extend the hoisted `wsMocks` and mocked `getWsClient()` shape:

```ts
const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  supportsCreateAttachSplitV1: vi.fn(() => false),
  supportsAttachViewportV1: vi.fn(() => false),
}))
```

```ts
it('new/new split path: sends terminal.create attachOnCreate:false then explicit attach with viewport', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(true)
  wsMocks.supportsAttachViewportV1.mockReturnValue(true)

  const { requestId } = await renderTerminalHarness({ status: 'creating', hidden: false })
  expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'terminal.create',
    requestId,
    attachOnCreate: false,
  }))

  wsMocks.send.mockClear()
  messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-split-1', createdAt: Date.now() })
  expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'terminal.attach',
    terminalId: 'term-split-1',
    sinceSeq: 0,
    cols: expect.any(Number),
    rows: expect.any(Number),
    attachRequestId: expect.any(String),
  }))
})

it('new/old skew path: without split capability, does not explicit attach after terminal.created', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(false)
  wsMocks.supportsAttachViewportV1.mockReturnValue(false)

  const { requestId } = await renderTerminalHarness({ status: 'creating', hidden: false })
  wsMocks.send.mockClear()
  messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-legacy-1', createdAt: Date.now() })

  const attachCalls = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-legacy-1')
  expect(attachCalls).toHaveLength(0)
})

it('hidden create path defers attach until visible and measured', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(true)
  wsMocks.supportsAttachViewportV1.mockReturnValue(true)

  const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({ status: 'creating', hidden: true })
  wsMocks.send.mockClear()
  messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-hidden-create', createdAt: Date.now() })

  let attachCalls = wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.attach')
  expect(attachCalls).toHaveLength(0)

  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>
  )

  attachCalls = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-hidden-create')
  expect(attachCalls).toHaveLength(1)
  expect(attachCalls[0]).toMatchObject({
    cols: expect.any(Number),
    rows: expect.any(Number),
    attachRequestId: expect.any(String),
  })
})

it('reconnect downgrade/upgrade changes apply only to future creates, not latched in-flight mode', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(true)
  wsMocks.supportsAttachViewportV1.mockReturnValue(true)
  const first = await renderTerminalHarness({ status: 'creating', hidden: false })
  expect(lastSent('terminal.create')).toMatchObject({ requestId: first.requestId, attachOnCreate: false })

  // simulate reconnect downgrade
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(false)
  wsMocks.supportsAttachViewportV1.mockReturnValue(false)
  triggerReconnect()

  // existing split terminal still reconnects via explicit attach generation
  emitServer({ type: 'terminal.created', requestId: first.requestId, terminalId: 'term-latched-1', createdAt: Date.now() })
  expect(lastSent('terminal.attach')).toMatchObject({ terminalId: 'term-latched-1' })

  // new create after downgrade must use legacy mode
  const second = await renderTerminalHarness({ status: 'creating', hidden: false })
  expect(lastSent('terminal.create')).toMatchObject({ requestId: second.requestId })
  expect(lastSent('terminal.create').attachOnCreate).toBeUndefined()
})
```

- [ ] **Step 3: Add failing hidden restore/remount e2e tests**

```ts
it('hidden remount restore sends zero attach while hidden and one viewport attach on visibility', async () => {
  const store = createStoreWithHiddenRestoredPane()
  const view = renderHiddenThenVisible(store)

  const hiddenAttaches = sentMessages().filter((m) => m.type === 'terminal.attach' && m.terminalId === 'term-hidden')
  expect(hiddenAttaches).toHaveLength(0)

  view.showHiddenTab()

  const visibleAttaches = sentMessages().filter((m) => m.type === 'terminal.attach' && m.terminalId === 'term-hidden')
  expect(visibleAttaches).toHaveLength(1)
  expect(visibleAttaches[0]).toMatchObject({
    sinceSeq: 7,
    cols: expect.any(Number),
    rows: expect.any(Number),
    attachRequestId: expect.any(String),
  })
})
```

- [ ] **Step 4: Run client/jsdom suites and verify RED**

Run:
`npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx --config vitest.config.ts`
Expected: FAIL on capability-gated flow + hidden deferred attach assertions.

- [ ] **Step 5: Implement ws-client capability storage helpers**

**File:** `src/lib/ws-client.ts`

```ts
private serverCapabilities: {
  createAttachSplitV1: boolean
  attachViewportV1: boolean
} = {
  createAttachSplitV1: false,
  attachViewportV1: false,
}

supportsCreateAttachSplitV1(): boolean {
  return this.serverCapabilities.createAttachSplitV1
}

supportsAttachViewportV1(): boolean {
  return this.serverCapabilities.attachViewportV1
}

if (msg.type === 'ready') {
  this.serverCapabilities = {
    createAttachSplitV1: !!msg.capabilities?.createAttachSplitV1,
    attachViewportV1: !!msg.capabilities?.attachViewportV1,
  }
}

if (ws.onclose) {
  // clear to unknown/legacy-safe defaults until next ready
  this.serverCapabilities = {
    createAttachSplitV1: false,
    attachViewportV1: false,
  }
}

// keep hello capability payload unchanged:
// { sessionsPatchV1, sessionsPaginationV1, uiScreenshotV1 }
// do not send createAttachSplitV1 / attachViewportV1 in hello
```

- [ ] **Step 6: Replace boolean hydration flags with explicit deferred-attach state**

**File:** `src/components/TerminalView.tsx`

```ts
type DeferredAttachState = {
  mode: 'none' | 'waiting_for_geometry' | 'attaching' | 'live'
  pendingSinceSeq: number
  pendingIntent: AttachIntent | null
}

const deferredAttachRef = useRef<DeferredAttachState>({
  mode: 'none',
  pendingSinceSeq: 0,
  pendingIntent: null,
})

const createModeByRequestIdRef = useRef<Map<string, 'legacy' | 'split'>>(new Map())
```

Transition rules to implement explicitly:

- Hidden split-mode create/restore: set `mode='waiting_for_geometry'`, do not send attach.
- Visible transition: run fit, capture `term.cols/term.rows`, send single attach with viewport, set `mode='attaching'`.
- Do **not** clear deferred state on `terminal.created` alone.
- Clear to `live` only when current attach generation completes (`attach.ready` with no pending replay, or replay completion via output/gap for same attach generation).

- [ ] **Step 7: Implement split/legacy branch in TerminalView create handler**

```ts
const splitMode = ws.supportsCreateAttachSplitV1() && ws.supportsAttachViewportV1()
createModeByRequestIdRef.current.set(requestId, splitMode ? 'split' : 'legacy')

ws.send({
  type: 'terminal.create',
  requestId,
  mode,
  shell,
  cwd,
  resumeSessionId,
  tabId,
  paneId,
  ...(splitMode ? { attachOnCreate: false } : {}),
})

// on terminal.created:
const modeForRequest = createModeByRequestIdRef.current.get(requestId) ?? 'legacy'
if (modeForRequest === 'split') {
  // explicit attach path (defer when hidden)
  queueOrSendAttachForCurrentVisibility(newId)
} else {
  // legacy path: no attach here; server auto-attach stream expected
}
```

- [ ] **Step 8: Ensure attach payload always carries viewport in split mode**

```ts
const viewport = getMeasuredViewportIfVisible()
if (!viewport) {
  // split mode invariant: never send attach without geometry
  deferredAttachRef.current = {
    mode: 'waiting_for_geometry',
    pendingSinceSeq: sinceSeq,
    pendingIntent: intent,
  }
  return
}

ws.send({
  type: 'terminal.attach',
  terminalId: tid,
  sinceSeq,
  attachRequestId,
  cols: viewport.cols,
  rows: viewport.rows,
})
```

For split mode, `terminal.attach` is never sent without `cols/rows`; hidden/immeasurable panes stay deferred until visible measurement succeeds.

- [ ] **Step 9: Re-run client/jsdom suites (GREEN)**

Run:
`npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx --config vitest.config.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/ws-client.ts src/components/TerminalView.tsx \
  test/unit/client/lib/ws-client.test.ts \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/e2e/terminal-settings-remount-scrollback.test.tsx \
  test/e2e/terminal-flaky-network-responsiveness.test.tsx

git commit -m "feat(client): capability-gated split attach flow with hidden-pane geometry defer"
```

---

## Chunk 4: Explicit Ordering Regression Coverage

### Task 4: Add high-signal ordering test for create/restore/reconnect paths

**Files:**
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

- [ ] **Step 1: Add failing e2e ordering test with concrete assertions**

```ts
it('split path ordering: create -> created -> attach(viewport) -> attach.ready -> replay/output', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(true)
  wsMocks.supportsAttachViewportV1.mockReturnValue(true)

  const { requestId, terminal, getAttachingIndicator } = await renderCreateHarness()
  const createMsg = lastSent('terminal.create')
  expect(createMsg).toMatchObject({ requestId, attachOnCreate: false })

  emitServer({ type: 'terminal.created', requestId, terminalId: 'term-order-1', createdAt: Date.now() })
  const attachMsg = lastSent('terminal.attach')
  expect(attachMsg).toMatchObject({
    terminalId: 'term-order-1',
    cols: expect.any(Number),
    rows: expect.any(Number),
    attachRequestId: expect.any(String),
  })

  emitServer({ type: 'terminal.attach.ready', terminalId: 'term-order-1', headSeq: 3, replayFromSeq: 1, replayToSeq: 3, attachRequestId: attachMsg.attachRequestId })
  emitServer({ type: 'terminal.output', terminalId: 'term-order-1', seqStart: 1, seqEnd: 1, data: 'hello', attachRequestId: attachMsg.attachRequestId })

  expect(terminal.write).toHaveBeenCalledWith('hello', expect.any(Function))
  expect(getAttachingIndicator()).toBeNull()
})

it('skew path ordering: no server split capability keeps legacy no-explicit-attach behavior', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(false)
  wsMocks.supportsAttachViewportV1.mockReturnValue(false)

  const { requestId } = await renderCreateHarness()
  clearSent()
  emitServer({ type: 'terminal.created', requestId, terminalId: 'term-order-legacy', createdAt: Date.now() })

  const explicitAttach = sentMessages().find((m) => m.type === 'terminal.attach' && m.terminalId === 'term-order-legacy')
  expect(explicitAttach).toBeUndefined()
})

it('transport_reconnect split path sends viewport attach before replay acceptance', async () => {
  wsMocks.supportsCreateAttachSplitV1.mockReturnValue(true)
  wsMocks.supportsAttachViewportV1.mockReturnValue(true)

  const { terminal, triggerReconnect } = await renderRunningHarness({ terminalId: 'term-order-reconnect' })
  clearSent()
  triggerReconnect()

  const reconnectAttach = lastSent('terminal.attach')
  expect(reconnectAttach).toMatchObject({
    terminalId: 'term-order-reconnect',
    cols: expect.any(Number),
    rows: expect.any(Number),
    attachRequestId: expect.any(String),
  })

  emitServer({
    type: 'terminal.output',
    terminalId: 'term-order-reconnect',
    seqStart: 10,
    seqEnd: 10,
    data: 'stale-before-ready',
    attachRequestId: 'old-generation',
  })
  expect(terminal.write).not.toHaveBeenCalledWith('stale-before-ready', expect.any(Function))

  emitServer({
    type: 'terminal.attach.ready',
    terminalId: 'term-order-reconnect',
    headSeq: 10,
    replayFromSeq: 11,
    replayToSeq: 10,
    attachRequestId: reconnectAttach.attachRequestId,
  })
  emitServer({
    type: 'terminal.output',
    terminalId: 'term-order-reconnect',
    seqStart: 11,
    seqEnd: 11,
    data: 'fresh-after-ready',
    attachRequestId: reconnectAttach.attachRequestId,
  })
  expect(terminal.write).toHaveBeenCalledWith('fresh-after-ready', expect.any(Function))
})
```

- [ ] **Step 2: Run jsdom e2e test and confirm RED**

Run: `npx vitest run test/e2e/terminal-create-attach-ordering.test.tsx --config vitest.config.ts`
Expected: FAIL until ordering logic is complete.

- [ ] **Step 3: Update server replay helper tests to explicit attach in split mode**

**File:** `test/server/ws-terminal-stream-v2-replay.test.ts`

Replace create helper pattern in split-capability scenarios:

```ts
async function createThenAttach(
  ws: WebSocket,
  requestId: string,
  viewport: { cols: number; rows: number },
): Promise<{ terminalId: string }> {
  ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId: created.terminalId,
    sinceSeq: 0,
    cols: viewport.cols,
    rows: viewport.rows,
    attachRequestId: `attach-${requestId}`,
  }))
  await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)
  return { terminalId: created.terminalId }
}
```

- [ ] **Step 4: Re-run ordering-focused suites (GREEN)**

Run:
`npx vitest run test/e2e/terminal-create-attach-ordering.test.tsx --config vitest.config.ts`

Run:
`npx vitest run test/server/ws-terminal-stream-v2-replay.test.ts --config vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/terminal-create-attach-ordering.test.tsx test/server/ws-terminal-stream-v2-replay.test.ts
git commit -m "test(terminal): lock ordering for split create/attach and skew fallback"
```

---

## Chunk 5: Enforceable Migration Barrier + Phase A Verification

### Task 5: Add operational gate so Chunk 6 cannot proceed while legacy clients still depend on auto-attach

**Files:**
- Create: `server/protocol-migration-gate.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Create: `scripts/check-option-c-migration-gate.mjs`
- Modify: `package.json`
- Create: `test/server/protocol-migration-gate.test.ts`

- [ ] **Step 1: Add failing migration-gate tests first**

```ts
it('tracks legacy and split create counters for 14d rolling gate', async () => {
  const gate = createProtocolMigrationGate({ now: () => new Date('2026-03-05T12:00:00Z') })
  gate.recordCreate({ clientId: 'legacy-a', mode: 'legacy_auto_attach' })
  gate.recordCreate({ clientId: 'split-a', mode: 'split_explicit_attach' })

  const snapshot = gate.snapshot()
  expect(snapshot.windowDays).toBe(14)
  expect(snapshot.legacyAutoAttachCreates14d).toBe(1)
  expect(snapshot.legacyClientIds14d).toBe(1)
  expect(snapshot.splitCreates14d).toBe(1)
})

it('migration checker fails while any legacy clients remain', async () => {
  const status = {
    windowDays: 14,
    legacyAutoAttachCreates14d: 3,
    legacyClientIds14d: 2,
    splitCreates14d: 600,
  }
  await expect(runGateCheck(status)).rejects.toThrow(/legacy.*non-zero/i)
})

it('migration checker passes only at strict zero-legacy threshold', async () => {
  const status = {
    windowDays: 14,
    legacyAutoAttachCreates14d: 0,
    legacyClientIds14d: 0,
    splitCreates14d: 600,
  }
  await expect(runGateCheck(status)).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run migration-gate tests and verify RED**

Run:
`npx vitest run test/server/protocol-migration-gate.test.ts --config vitest.server.config.ts`
Expected: FAIL on missing tracker/checker implementation.

- [ ] **Step 3: Implement telemetry + endpoint + checker command**

**`server/ws-handler.ts`**

```ts
// on terminal.create handling in Phase A
this.protocolMigrationGate.recordCreate({
  clientId: state.clientInstanceId ?? 'unknown',
  mode: m.attachOnCreate === false ? 'split_explicit_attach' : 'legacy_auto_attach',
})
```

**`server/index.ts`**

```ts
app.get('/api/admin/protocol-migration-status', requireAdmin, (_req, res) => {
  res.json(this.wsHandler.getProtocolMigrationSnapshot())
})
```

**`scripts/check-option-c-migration-gate.mjs`**

```js
if (snapshot.legacyAutoAttachCreates14d !== 0) fail('legacyAutoAttachCreates14d must be 0')
if (snapshot.legacyClientIds14d !== 0) fail('legacyClientIds14d must be 0')
if (snapshot.splitCreates14d < Number(args.minSplitCreates ?? 100)) fail('splitCreates14d below minimum floor')
```

**`package.json`**

```json
{
  "scripts": {
    "protocol:migration:gate": "node scripts/check-option-c-migration-gate.mjs --url http://127.0.0.1:5174/api/admin/protocol-migration-status --min-split-creates 100"
  }
}
```

- [ ] **Step 4: Re-run migration-gate tests (GREEN)**

Run:
`npx vitest run test/server/protocol-migration-gate.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 5: Run gate command in strict mode**

Run:
`npm run protocol:migration:gate`
Expected:
- PASS only when `legacyAutoAttachCreates14d=0` and `legacyClientIds14d=0`.
- FAIL otherwise (this is the enforced barrier to entering Chunk 6).

- [ ] **Step 6: Verify Phase A matrix and full suite**

Run:
`npx vitest run test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts --config vitest.server.config.ts`

Run:
`npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx --config vitest.config.ts`

Run:
`npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/protocol-migration-gate.ts server/ws-handler.ts server/index.ts \
  scripts/check-option-c-migration-gate.mjs package.json test/server/protocol-migration-gate.test.ts
git commit -m "feat(migration-gate): enforce zero-legacy barrier before option-c cleanup"
```

---

## Chunk 6: Bounded Final Convergence (Remove Create Auto-Attach Contract)

### Task 6: Remove legacy create auto-attach/replay and close the migration

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-create-attach-ordering.test.tsx`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

- [ ] **Step 0: Re-validate migration barrier (hard precondition)**

Run: `npm run protocol:migration:gate`

Expected:
- PASS required to proceed.
- If FAIL, stop Chunk 6 and keep legacy path; plan is incomplete by definition.

- [ ] **Step 1: Add failing end-state tests first (server + client)**

```ts
it('final contract: terminal.create never emits terminal.attach.ready', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-no-auto', mode: 'shell' }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-no-auto')
  const msgs = await collectMessages(ws, 200)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
  await close()
})

it('final contract applies to reuse/idempotency branches too', async () => {
  const { ws, close } = await createAuthenticatedConnection()

  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-dup-1', mode: 'shell' }))
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-dup-1', mode: 'shell' }))
  const createdDup = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-dup-1')
  const dupMsgs = await collectMessages(ws, 150)
  expect(dupMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === createdDup.terminalId)).toBe(false)

  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-reuse-codex', mode: 'codex', resumeSessionId: CODEX_SESSION_ID }))
  const createdReuse = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-reuse-codex')
  const reuseMsgs = await collectMessages(ws, 150)
  expect(reuseMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === createdReuse.terminalId)).toBe(false)

  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId: createdReuse.terminalId,
    sinceSeq: 0,
    cols: 120,
    rows: 40,
    attachRequestId: 'final-reuse-attach-1',
  }))
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'final-reuse-attach-1')
  expect(ready.terminalId).toBe(createdReuse.terminalId)
  await close()
})

it('final contract: terminal.attach without viewport is rejected and never replays', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-vp-required', mode: 'shell' }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-vp-required')

  registry.simulateOutput(created.terminalId, 'must-not-replay')
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0 }))
  const err = await waitForMessage(ws, (m) => m.type === 'error')
  expect(err.code).toBe('INVALID_MESSAGE')

  const msgs = await collectMessages(ws, 200)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
  expect(msgs.some((m) => m.type === 'terminal.output' && String(m.data).includes('must-not-replay'))).toBe(false)
  await close()
})

it('final explicit-only client: queued create before ready flushes once, then guaranteed attach path executes', async () => {
  const { wsClient, ws } = createClientHarness({ lifecycleMode: 'explicit-only' })
  wsClient.createTerminal({ requestId: 'final-queued-1', mode: 'shell' })
  expect(sentMessages(ws).some((m) => m.type === 'terminal.create')).toBe(false)

  emitServer(ws, { type: 'ready', capabilities: { createAttachSplitV1: true, attachViewportV1: true } })
  expect(sentMessages(ws).filter((m) => m.type === 'terminal.create' && m.requestId === 'final-queued-1')).toHaveLength(1)

  emitServer(ws, { type: 'terminal.created', requestId: 'final-queued-1', terminalId: 'term-final-queued', createdAt: Date.now() })
  expect(sentMessages(ws).filter((m) => m.type === 'terminal.attach' && m.terminalId === 'term-final-queued')).toHaveLength(1)
})

it('final explicit-only reconnect window: created-before-ready still yields exactly one attach after ready', async () => {
  const h = createClientHarness({ lifecycleMode: 'explicit-only' })
  h.sendCreate('final-reconnect-queued')
  h.simulateReconnectOpenWithoutReady()
  h.emitCreated('final-reconnect-queued', 'term-final-reconnect')
  expect(h.sent('terminal.attach', 'term-final-reconnect')).toHaveLength(0)
  h.emitReady()
  expect(h.sent('terminal.attach', 'term-final-reconnect')).toHaveLength(1)
})
```

- [ ] **Step 2: Add objective gate checks in plan execution notes**

```text
Gate A (code): no call sites of terminalStreamBroker.sendCreatedAndAttach remain.
Gate B (tests): all create/reuse/idempotency tests assert explicit attach requirement.
Gate C (behavior): npm test passes with final-contract assertions enabled.
Gate D (operations): latest `npm run protocol:migration:gate` output is attached and passing in the same change set.
Gate E (protocol): attach without viewport is rejected before any replay can start.
Gate F (lifecycle): queued/reconnect create flows prove no `created-without-attach` dead-end.
```

- [ ] **Step 3: Implement final cleanup**

```ts
// shared/ws-protocol.ts
// Final-state contract: viewport is required on terminal.attach
export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  attachRequestId: z.string().min(1).optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
})

// server/ws-handler.ts
const createdMsg = {
  type: 'terminal.created',
  requestId: m.requestId,
  terminalId: record.terminalId,
  createdAt: record.createdAt,
  ...(effectiveResumeSessionId ? { effectiveResumeSessionId } : {}),
}
this.send(ws, createdMsg)
// apply this for fresh create, duplicate requestId, existingAfterConfig, and canonical reuse.
// ignore attachOnCreate in final state (accepted for wire compatibility only).
// reject attach without viewport (schema + defensive guard), and always call resize before broker.attach.
// every created response path calls the same create-result helper so the client lifecycle guarantee is uniform.

// server/terminal-stream/broker.ts
// delete sendCreatedAndAttach() and its exports/usages.

// src/lib/ws-client.ts
if (msg.type === 'terminal.create' && this.lifecycleMode === 'explicit-only' && !this.readyReceived) {
  this.preReadyCreateQueue.set(msg.requestId, msg)
  return
}

if (incoming.type === 'ready' && this.lifecycleMode === 'explicit-only') {
  this.readyReceived = true
  for (const createMsg of this.preReadyCreateQueue.values()) this.sendNow(createMsg)
  this.preReadyCreateQueue.clear()
}

// src/components/TerminalView.tsx
// remove legacy-mode branch; every create is explicit attach lifecycle
pendingCreateLifecycleRef.current.set(requestId, { phase: 'await_created', attachGeneration: 0 })
onTerminalCreated((created) => {
  const lifecycle = pendingCreateLifecycleRef.current.get(created.requestId)
  if (!lifecycle) return
  queueOrSendAttachForCurrentVisibility(created.terminalId) // always viewport attach; hidden => deferred waiting_for_geometry
})
```

- [ ] **Step 4: Update all create-path tests to explicit attach**

```ts
async function createOnly(ws: WebSocket, requestId: string): Promise<string> {
  ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
  const msgs = await collectMessages(ws, 150)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
  return created.terminalId
}

async function attachWithViewport(ws: WebSocket, terminalId: string, attachRequestId: string): Promise<void> {
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, sinceSeq: 0, cols: 120, rows: 40, attachRequestId }))
  const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === attachRequestId)
  expect(ready.terminalId).toBe(terminalId)
}

it('final existingId branch returns created only and requires explicit attach', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const existing = await seedRunningCodexTerminal(ws, CODEX_SESSION_ID)
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-existing-id', mode: 'codex', resumeSessionId: CODEX_SESSION_ID }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-existing-id')
  expect(created.terminalId).toBe(existing.terminalId)
  const msgs = await collectMessages(ws, 150)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === existing.terminalId)).toBe(false)
  await attachWithViewport(ws, existing.terminalId, 'final-existing-id-attach-1')
  await close()
})

it('final existingAfterConfig branch returns created only and requires explicit attach', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const existing = await seedRunningClaudeTerminalAfterConfig(ws, CLAUDE_SESSION_ID)
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-existing-after-config', mode: 'claude', resumeSessionId: CLAUDE_SESSION_ID }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-existing-after-config')
  expect(created.terminalId).toBe(existing.terminalId)
  const msgs = await collectMessages(ws, 150)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === existing.terminalId)).toBe(false)
  await attachWithViewport(ws, existing.terminalId, 'final-existing-after-config-attach-1')
  await close()
})

it('final duplicate requestId branch is idempotent and never auto-attaches', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-dup-branch', mode: 'shell' }))
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'final-dup-branch', mode: 'shell' }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'final-dup-branch')
  const msgs = await collectMessages(ws, 200)
  const createdCount = msgs.filter((m) => m.type === 'terminal.created' && m.requestId === 'final-dup-branch').length + 1
  expect(createdCount).toBe(1)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
  await attachWithViewport(ws, created.terminalId, 'final-dup-attach-1')
  await close()
})
```

- [ ] **Step 5: Run end-state suites**

Run:
`npx vitest run test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/protocol-migration-gate.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts --config vitest.server.config.ts`

Run:
`npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx --config vitest.config.ts`

Run:
`npm test`

Expected: PASS, with no create auto-attach behavior remaining.

- [ ] **Step 6: Commit final convergence**

```bash
git add shared server src test
git commit -m "feat(protocol): finalize explicit create->attach lifecycle with strict viewport enforcement"
```

---

## Definition of Done (Must Be Demonstrated)

- [ ] Final state: `terminal.create` never auto-attaches or replays in any branch (fresh, idempotent, reused).
- [ ] `terminal.attach` is the only replay entrypoint and enforces resize-before-replay ordering for each attach generation.
- [ ] Dual-mode compatibility is preserved during Phase A, then removed in Chunk 6 with passing final-contract tests.
- [ ] Chunk 6 is blocked by an enforceable migration barrier: `npm run protocol:migration:gate` must pass with `legacyAutoAttachCreates14d=0` and `legacyClientIds14d=0`; if not, plan remains incomplete.
- [ ] New/old skew safety in Phase A: missing `ready` split capabilities yields legacy create behavior (no explicit attach-after-created).
- [ ] Negotiation is coherent and one-way: split flags are advertised only in `ready.capabilities`; hello does not carry split flags.
- [ ] Split attach without viewport in Phase A remains compatibility-safe by applying terminal current geometry and still preserving `resize -> ready -> output` order.
- [ ] Final state enforces viewport on every `terminal.attach`; missing `cols/rows` is rejected and no replay bytes are emitted.
- [ ] Restore ordering test proves `resize -> attach.ready -> replay output`.
- [ ] Transport reconnect ordering test proves `resize -> attach.ready -> replay output` for reconnect attach generation.
- [ ] Duplicate requestId and reuse helpers (existingId, existingAfterConfig, canonical reuse, duplicate requestId) are covered in both Phase A and final state with no duplicate replay churn.
- [ ] Capability state tests cover connect-failure flush and reconnect downgrade/upgrade windows.
- [ ] Final explicit-only client tests prove queued/pre-ready create and reconnect windows cannot end in `created-without-attach` dead-end.
- [ ] Hidden-pane create/restore: zero attach while hidden; exactly one attach with concrete viewport on visibility; deferred hydration state not cleared early.
- [ ] Commands use correct Vitest configs: server tests under `vitest.server.config.ts`, client/e2e/jsdom tests under `vitest.config.ts`.
