# Option C Terminal Attach Viewport + Create/Attach Decoupling Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix terminal restore/refresh scroll corruption by ensuring replay cannot start before server-applied geometry, and move terminal lifecycle to explicit `create -> attach` for capable clients without breaking mixed-version deployments.

**Architecture:** Implement a dual-mode rollout with one-way negotiation. Server advertises split support in `ready.capabilities`; client opts into split mode only when those capabilities are present, by sending `terminal.create` with `attachOnCreate:false`. Server behavior keys on `attachOnCreate` (not hello-advertised split flags): omitted/true keeps legacy auto-attach, false requires explicit attach. Hidden panes use a geometry-gated deferred attach state so replay never starts until concrete dimensions are known and applied server-side.

**Tech Stack:** TypeScript, React 18, xterm.js, Node/Express, WebSocket (`ws`), Zod protocol validation, Vitest (`vitest.config.ts` for client/jsdom; `vitest.server.config.ts` for server/node).

---

## Compatibility Matrix (Required Behavior)

- `Old client + New server`: Must remain legacy-safe. New server auto-attaches by default when client does not opt into split mode.
- `New client + Old server`: Must remain legacy-safe. New client must detect missing `ready.capabilities.createAttachSplitV1` and stay in legacy create path (no explicit attach-after-created).
- `New client + New server`: Must use split mode (`create` sends `attachOnCreate:false`; explicit attach with viewport).
- `Old client + Old server`: Unchanged.

### Negotiation Model (Authoritative)

- Server -> client negotiation only: `ready.capabilities`.
- Client -> server selection: `terminal.create.attachOnCreate`.
- Server does **not** infer split support from hello capabilities.
- Client hello payload must remain unchanged for split flags (no `createAttachSplitV1`/`attachViewportV1` in hello), preventing contradictory two-way gating.

### Anti-regression invariants

- No `created`-without-attach dead-end in any matrix cell.
- No duplicate replay churn caused by both auto-attach and explicit attach in skew windows.
- Hidden-pane create/restore cannot replay before concrete geometry is applied server-side.

---

## File Structure Map

- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
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

it('split attach without viewport is rejected and does not emit attach.ready', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'split-missing-vp', mode: 'shell', attachOnCreate: false }))
  const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'split-missing-vp')

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: created.terminalId, sinceSeq: 0 }))
  const err = await waitForMessage(ws, (m) => m.type === 'error')
  expect(err.code).toBe('INVALID_MESSAGE')
  expect(String(err.message)).toContain('viewport')

  const msgs = await collectMessages(ws, 150)
  expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
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

if (autoAttach) {
  const attached = await this.terminalStreamBroker.sendCreatedAndAttach(ws, {
    requestId: m.requestId,
    terminalId: record.terminalId,
    createdAt: record.createdAt,
    effectiveResumeSessionId,
  })
  if (attached) state.attachedTerminalIds.add(record.terminalId)
} else {
  this.splitAttachTerminalIds.add(record.terminalId)
  this.send(ws, {
    type: 'terminal.created',
    requestId: m.requestId,
    terminalId: record.terminalId,
    createdAt: record.createdAt,
    ...(effectiveResumeSessionId ? { effectiveResumeSessionId } : {}),
  })
}
```

- [ ] **Step 5: Implement attach viewport-then-replay ordering**

**File:** `server/ws-handler.ts`

```ts
const splitAttach = this.splitAttachTerminalIds.has(m.terminalId)
const hasViewport = typeof m.cols === 'number' && typeof m.rows === 'number'

if (splitAttach && !hasViewport) {
  this.sendError(ws, {
    code: 'INVALID_MESSAGE',
    message: 'Split attach requires viewport cols and rows',
    terminalId: m.terminalId,
  })
  return
}

if (hasViewport) {
  const resized = this.registry.resize(m.terminalId, m.cols!, m.rows!)
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
```

Transition rules to implement explicitly:

- Hidden split-mode create/restore: set `mode='waiting_for_geometry'`, do not send attach.
- Visible transition: run fit, capture `term.cols/term.rows`, send single attach with viewport, set `mode='attaching'`.
- Do **not** clear deferred state on `terminal.created` alone.
- Clear to `live` only when current attach generation completes (`attach.ready` with no pending replay, or replay completion via output/gap for same attach generation).

- [ ] **Step 7: Implement split/legacy branch in TerminalView create handler**

```ts
const splitMode = ws.supportsCreateAttachSplitV1() && ws.supportsAttachViewportV1()

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
if (splitMode) {
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

## Chunk 5: Final Verification + Cleanup

### Task 5: Verify matrix end-to-end and complete full regression run

**Files:**
- Modify: `server/terminal-stream/broker.ts` (only if minor helper cleanup is still needed)
- Modify: any touched tests for final clarity

- [ ] **Step 1: Matrix verification tests (server + client)**

Run:
`npx vitest run test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts --config vitest.server.config.ts`

Run:
`npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx --config vitest.config.ts`

Expected: PASS.

- [ ] **Step 2: Full suite gate**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Final commit**

```bash
git add server src test shared
git commit -m "refactor(terminal): finalize skew-safe option-c create/attach viewport rollout"
```

---

## Definition of Done (Must Be Demonstrated)

- [ ] New/new path: `terminal.create` (with `attachOnCreate:false`) does not auto-attach; explicit `terminal.attach` with `cols/rows` required and replay starts only after server applies resize.
- [ ] Old/new path: old client (no split capability) still receives `terminal.attach.ready` from `terminal.create` legacy auto-attach path.
- [ ] New/old path: new client detects missing ready capabilities and does not send explicit attach-after-created, preventing duplicate replay churn.
- [ ] Negotiation is coherent and one-way: split flags are advertised only in `ready.capabilities`; hello does not carry split flags.
- [ ] Split attach without viewport is rejected (`INVALID_MESSAGE`) and emits no `terminal.attach.ready` or replay output.
- [ ] Restore ordering test proves `resize -> attach.ready -> replay output`.
- [ ] Transport reconnect ordering test proves `resize -> attach.ready -> replay output` for reconnect attach generation.
- [ ] Hidden-pane create/restore: zero attach while hidden; exactly one attach with concrete viewport on visibility; deferred hydration state not cleared early.
- [ ] Commands use correct Vitest configs: server tests under `vitest.server.config.ts`, client/e2e/jsdom tests under `vitest.config.ts`.
