# Option C Terminal Attach Viewport + Create/Attach Decoupling Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate restore/refresh scroll-position corruption by making `terminal.attach` carry viewport dimensions (server resizes before replay) and by removing the implicit create-time auto-attach contract.

**Architecture:** Split terminal lifecycle into two explicit phases: `terminal.create` allocates/returns `terminalId`, and `terminal.attach` owns stream subscription + replay. Extend attach with optional viewport dimensions (`cols`/`rows`) and apply resize before replay in the server attach path. Keep rollout backward-compatible by accepting attach requests without viewport dimensions, while updating the current UI client to always send viewport data when available.

**Tech Stack:** TypeScript, React 18, xterm.js, Node/Express, WebSocket (`ws`), Zod schemas, Vitest (unit/server/e2e).

---

## File Structure Map

- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`

## Trycycle Cadence

Use `@trycycle` for each chunk:
1. Write failing tests first.
2. Implement minimum code to pass.
3. Refactor for clarity/invariants.
4. Re-run focused tests, then commit.

## Chunk 1: Protocol + Server Contract

### Task 1: Add failing protocol tests for attach viewport shape

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `shared/ws-protocol.ts`

- [ ] **Step 1: Write failing schema/behavior tests (no code changes yet)**

```ts
it('terminal.attach accepts both cols and rows together', async () => {
  // send {type:'terminal.attach', terminalId, cols:120, rows:40}
  // expect terminal.attach.ready
})

it('terminal.attach rejects partial viewport payload', async () => {
  // send cols without rows
  // expect INVALID_MESSAGE
})
```

- [ ] **Step 2: Run focused test to confirm failure**

Run: `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: FAIL on new attach viewport cases.

- [ ] **Step 3: Implement protocol contract in Zod**

```ts
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
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal.attach cols/rows must be provided together' })
  }
})
```

- [ ] **Step 4: Re-run focused tests**

Run: `npx vitest run test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS for new schema checks.

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts test/server/ws-protocol.test.ts
git commit -m "test(protocol): require paired attach viewport dimensions"
```

### Task 2: Add failing server contract tests (create no longer auto-attaches)

**Files:**
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

- [ ] **Step 1: Write failing tests for Option C server semantics**

```ts
it('terminal.create returns terminal.created without terminal.attach.ready', async () => {
  // wait short window after terminal.created; assert no attach.ready
})

it('reused terminal.create returns terminal.created only; client must attach explicitly', async () => {
  // codex/claude reuse tests
})

it('terminal.attach applies viewport resize before replay', async () => {
  // assert registry.resizeCalls includes {cols, rows} before attach.ready is observed
})

it('terminal.attach remains backward-compatible without viewport', async () => {
  // old payload still attaches and replays
})
```

- [ ] **Step 2: Run focused tests to confirm failure**

Run:
`npx vitest run test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts --config vitest.server.config.ts`
Expected: FAIL (current create path still auto-attaches).

- [ ] **Step 3: Implement ws-handler create/attach split**

**Files:**
- Modify: `server/ws-handler.ts`

```ts
// create path: send only terminal.created
this.send(ws, {
  type: 'terminal.created',
  requestId: m.requestId,
  terminalId: record.terminalId,
  createdAt: record.createdAt,
  ...(effectiveResumeSessionId ? { effectiveResumeSessionId } : {}),
})

// attach path: resize first when viewport provided
if (typeof m.cols === 'number' && typeof m.rows === 'number') {
  const resized = this.registry.resize(m.terminalId, m.cols, m.rows)
  if (!resized) {
    this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
    return
  }
}
const attached = await this.terminalStreamBroker.attach(ws, m.terminalId, m.sinceSeq, m.attachRequestId)
```

- [ ] **Step 4: Remove obsolete broker helper usage**

**Files:**
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/ws-handler.ts`

```ts
// delete sendCreatedAndAttach helper (or keep private only if still needed)
// all create callers should now call this.send('terminal.created') directly
```

- [ ] **Step 5: Re-run focused server tests**

Run:
`npx vitest run test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/ws-handler.ts server/terminal-stream/broker.ts \
  test/server/ws-edge-cases.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts \
  test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts \
  test/server/ws-protocol.test.ts
git commit -m "feat(server): decouple terminal.create from attach and apply attach viewport resize"
```

## Chunk 2: Client Attach Viewport Semantics

### Task 3: Add failing client tests for explicit attach-after-create with viewport

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

- [ ] **Step 1: Replace old auto-attach assumptions with Option C expectations**

```ts
it('after terminal.created, sends terminal.attach (sinceSeq=0) with cols/rows', async () => {
  // clear sent messages before emitting terminal.created
  // expect attach message has cols + rows + attachRequestId
})

it('does not rely on create-time attach.ready without explicit attach', async () => {
  // no attach.ready handling until attach request is sent
})

it('reconnect/restore attach requests include viewport dimensions when available', async () => {
  // lifecycle + settings remount paths
})
```

- [ ] **Step 2: Run focused client tests to confirm failure**

Run:
`npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx`
Expected: FAIL on attach payload expectations.

- [ ] **Step 3: Implement attach viewport builder and create->attach sequence**

**Files:**
- Modify: `src/components/TerminalView.tsx`

```ts
const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null)

function resolveAttachViewport(): { cols: number; rows: number } | undefined {
  const term = termRef.current
  if (!term) return undefined

  if (!hiddenRef.current && runtimeRef.current) {
    try { runtimeRef.current.fit() } catch {}
    if (term.cols >= 2 && term.rows >= 2) {
      lastViewportRef.current = { cols: term.cols, rows: term.rows }
      return lastViewportRef.current
    }
  }

  return lastViewportRef.current ?? undefined
}

// attach send
const viewport = resolveAttachViewport()
ws.send({
  type: 'terminal.attach',
  terminalId: tid,
  sinceSeq,
  attachRequestId,
  ...(viewport ?? {}),
})

// terminal.created handler
updateContent({ terminalId: newId, status: 'running' })
attachTerminal(newId, 'viewport_hydrate')
```

- [ ] **Step 4: Keep layout resize path but remove create-time resize dependency**

```ts
// remove direct ws.send({type:'terminal.resize', ...}) from terminal.created handler
// keep existing visibility/layout-driven resize for ongoing viewport changes
```

- [ ] **Step 5: Re-run focused client tests**

Run:
`npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalView.tsx \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/e2e/terminal-settings-remount-scrollback.test.tsx \
  test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "feat(client): send viewport dimensions on terminal.attach and attach explicitly after create"
```

## Chunk 3: End-to-End Ordering Coverage (Create / Restore / Reconnect)

### Task 4: Add explicit e2e regression for create/attach ordering

**Files:**
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`

- [ ] **Step 1: Write failing e2e test for create ordering**

```ts
it('create -> created -> attach(viewport) -> attach.ready ordering is explicit and stable', async () => {
  // render creating pane
  // assert terminal.create sent
  // emit terminal.created
  // assert next attach includes cols/rows and attachRequestId
  // emit attach.ready + output; assert output renders
})
```

- [ ] **Step 2: Run the new e2e test to confirm failure first**

Run: `npx vitest run test/e2e/terminal-create-attach-ordering.test.tsx`
Expected: FAIL before final ordering adjustments.

- [ ] **Step 3: Adjust client/server test harnesses to reflect final contract**

**Files:**
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-protocol.test.ts`

```ts
// helpers should explicitly call terminal.attach after terminal.created
async function createAndAttach(...) {
  // send terminal.create
  // wait terminal.created
  // send terminal.attach { cols, rows }
  // wait terminal.attach.ready
}
```

- [ ] **Step 4: Re-run ordering-focused suites**

Run:
`npx vitest run test/e2e/terminal-create-attach-ordering.test.tsx test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/terminal-create-attach-ordering.test.tsx \
  test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts
git commit -m "test(e2e): cover explicit create-attach ordering with viewport resize"
```

## Chunk 4: Refactor + Full Verification

### Task 5: Refactor for clarity and run full test matrix

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TerminalView.tsx`

- [ ] **Step 1: Refactor duplicated attach/create helpers into named functions**

```ts
function sendTerminalCreated(...) { ... }
function applyAttachViewportIfPresent(...) { ... }
function buildAttachPayload(...) { ... }
```

- [ ] **Step 2: Run targeted fast checks after refactor**

Run:
`npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/server/ws-edge-cases.test.ts --config vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 3: Run full project tests (required pre-merge gate)**

Run: `npm test`
Expected: PASS (all suites green).

- [ ] **Step 4: Commit final refactor + verification updates**

```bash
git add server/ws-handler.ts src/components/TerminalView.tsx
# include any adjusted tests from final refactor
git add test/server test/unit test/e2e

git commit -m "refactor(terminal): finalize attach viewport contract and full-suite verification"
```

## Rollout/Compatibility Checks

- [ ] Legacy clients that send `terminal.attach` without `cols/rows` still attach/replay successfully.
- [ ] New clients send `cols/rows` on attach for create/restore/reconnect paths when viewport is known.
- [ ] `terminal.create` never implies server-side attach; all replay is gated behind explicit attach.
- [ ] Reused-session create paths (Codex/Claude) follow the same explicit attach contract.

