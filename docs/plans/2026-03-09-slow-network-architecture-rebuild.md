# Slow-Network Architecture Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Use `@trycycle-executing` for execution handoff.

**Goal:** Replace Freshell's client-heavy, bulk-replay transport with a server-authoritative, viewport-first architecture that stays responsive on slow links by shipping only visible, latency-sensitive state immediately and paging everything else on demand.

**Architecture:** Hard-cut to WebSocket protocol v4 with one responsibility: realtime delivery of small, latency-sensitive events. Move bulky state onto explicit HTTP read models that match UI needs directly: one bootstrap document, one session directory surface, one agent timeline surface, and one terminal viewport/search surface. Back those read models with incremental server-side indices and mirrors plus a visible-vs-background work scheduler so visible state, terminal input, and live deltas cannot be starved by offscreen fetches.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, existing `session-scanner`/`session-search` infrastructure, existing `terminal-stream/broker`, `xterm`, `@xterm/headless`, `@xterm/addon-serialize`.

---

## Strategy Gate

The real problem is not "chunk better." The real problem is that WebSocket is still carrying read models: large session snapshots, full SDK histories, and replay-oriented terminal restore behavior. That architecture guarantees that slow-link pain comes back in new forms even if individual payloads get smaller.

The simplest architecture that directly lands the user's requested end state is:

1. WebSocket becomes a realtime lane only.
2. The server owns shaping, searching, summarizing, pagination, and prioritization.
3. The client stores only visible windows plus cursors, not full histories.
4. Offscreen data is fetched later, cancelled when stale, and never replayed before visible state.

Do not preserve the old model behind compatibility shims. The old socket bulk paths are the defect. The user explicitly asked for a real rearchitecture and authorized the extra planning depth, so this plan chooses the direct cutover instead of an incremental "stabilize first" migration.

## Acceptance Criteria

1. App startup uses exactly one HTTP bootstrap document before opening the realtime socket.
2. WebSocket v4 carries no bulk session directory payloads, no socket pagination for sessions, and no `sdk.history` arrays.
3. Reconnect restores what the user can see now:
   - terminal: current screen first, then optional older scrollback/search on demand
   - agent chat: recent turns first, older turn bodies later or on expand
   - session views: current query window only
4. Search is server-side for session title, session messages, session full text, and terminal content.
5. Background fetches are abortable and do not block terminal input, terminal live output, or visible-window fetches.
6. Server read models are incremental and bounded; they do not rebuild full client-shaped payloads on every request.
7. Realtime message size is explicitly budgeted and enforced.
8. The full regression suite proves slow/flaky-network behavior, not just unit-level correctness.

## End-State Architecture

### Transport Lanes

1. **Realtime WebSocket lane**
   - `ready`
   - terminal lifecycle and live output
   - lightweight SDK live events, status, permissions, questions
   - `sessions.changed` invalidation
   - terminal metadata deltas
   - errors and extension lifecycle
2. **Visible HTTP lane**
   - `/api/bootstrap`
   - `/api/session-directory`
   - `/api/agent-sessions/:sessionId/timeline`
   - `/api/agent-sessions/:sessionId/turns/:turnId`
   - `/api/terminals/:terminalId/viewport`
3. **Background HTTP lane**
   - older session pages
   - older agent timeline pages
   - terminal scrollback pages
   - terminal search pages

### Server Authority

1. Session directory data comes from the server's indexed session inventory, not from client-side filtering of `ProjectGroup[]`.
2. Agent chat lives on the server as turns, not only as flat message arrays.
3. Terminal restore/search uses a server-side mirror of terminal state, not client-side search across whatever backlog happened to arrive.
4. The client may cache visible windows briefly, but the server is authoritative for ordering, filtering, snippets, summaries, cursors, and revision numbers.

### Priority and Cancellation

1. Introduce a server `ReadModelWorkScheduler` with reserved visible capacity and capped background capacity.
2. Visible requests always outrank background requests.
3. Background requests must listen for request abort and stop work when the user changes query/view.
4. Client components use `AbortController` plus generation checks so stale background responses never overwrite current visible state.

### Direct Cutover Rules

1. Bump `WS_PROTOCOL_VERSION` to `4`.
2. Reject older clients with close code `4010` and `PROTOCOL_MISMATCH`.
3. Remove runtime use of:
   - `sessions.updated`
   - `sessions.page`
   - `sessions.patch`
   - `sessions.fetch`
   - `sdk.history`
4. Keep no backward-compatibility shim after the cutover. Old clients fail fast.

## System Invariants

1. Terminal input must never wait behind session queries, history hydration, or search.
2. Any payload that routinely exceeds the realtime budget belongs on HTTP, not WebSocket.
3. Offscreen data is paged and fetched only after visible state is rendered or when the user explicitly asks for it.
4. Client restore logic must never count upward through old history before showing the current visible state.
5. Search, snippets, summaries, and title matching are server-side concerns.
6. When state becomes uncertain, refetch the active server window instead of rebuilding large client-side reconciliation logic.

## Normative Contracts

### Realtime Budget

```ts
const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
```

If a message would routinely exceed that size, redesign the transport. Do not chunk it onto the realtime socket.

### Session Directory

```ts
type SessionDirectoryQuery = {
  text: string
  tier: 'title' | 'userMessages' | 'fullText'
  view: 'sidebar' | 'history'
}

type SessionDirectoryItem = {
  key: string
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  projectName: string
  title: string
  summary?: string
  snippet?: string
  updatedAt: number
  createdAt?: number
  archived: boolean
  isRunning: boolean
  runningTerminalId?: string
  cwd?: string
}

type SessionDirectoryPage = {
  revision: number
  query: SessionDirectoryQuery
  items: SessionDirectoryItem[]
  nextCursor?: string
  totalItems: number
  partial?: boolean
  partialReason?: 'budget' | 'io_error'
}
```

### Agent Timeline

```ts
type AgentTurnSummary = {
  turnId: string
  startedAt: string
  finishedAt?: string
  status: 'complete' | 'streaming' | 'interrupted'
  userPreview: string
  assistantPreview: string
  toolCount: number
  hasThinking: boolean
  bodyState: 'hydrated' | 'summary_only'
}

type AgentTimelinePage = {
  sessionId: string
  revision: number
  items: AgentTurnSummary[]
  nextCursor?: string
  recentExpandedTurnIds: string[]
}

type AgentTurnBody = {
  sessionId: string
  turnId: string
  messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp?: string }>
}
```

### Terminal View

```ts
type TerminalViewportSnapshot = {
  terminalId: string
  revision: number
  cols: number
  rows: number
  tailSeq: number
  serialized: string
  hasOlderScrollback: boolean
  scrollbackCursor?: string
}

type TerminalScrollbackPage = {
  terminalId: string
  revision: number
  serialized: string
  scrollbackCursor?: string
  hasOlderScrollback: boolean
}

type TerminalSearchResponse = {
  terminalId: string
  revision: number
  query: string
  results: Array<{
    resultId: string
    preview: string
    scrollbackCursor: string
  }>
  nextCursor?: string
}
```

## Heavy Test Matrix

The execution agent must add red-green coverage at every task, then run the full matrix below before declaring the work done:

1. Protocol tests proving v4 rejects old clients and never emits legacy bulk messages.
2. Server unit tests for:
   - read-model scheduler priority and cancellation
   - session directory cursoring and search
   - agent timeline turn folding
   - terminal mirror serialization/search correctness
3. Server integration tests for:
   - `/api/bootstrap`
   - `/api/session-directory`
   - `/api/agent-sessions/:sessionId/timeline`
   - `/api/agent-sessions/:sessionId/turns/:turnId`
   - `/api/terminals/:terminalId/viewport`
   - `/api/terminals/:terminalId/scrollback`
   - `/api/terminals/:terminalId/search`
4. Client unit tests proving:
   - App bootstraps from one HTTP document
   - Sidebar and HistoryView no longer do local title filtering
   - agent chat no longer restores from full `sdk.history`
   - terminal search no longer uses `SearchAddon`
5. Slow-network e2e tests proving:
   - startup becomes interactive before offscreen data loads
   - terminal reconnect shows current screen without replaying entire history
   - agent chat reload shows recent visible turns before older ones
   - session search works without shipping the full dataset to the browser
   - background bulk requests do not delay terminal input
6. Final verification commands:

```bash
npm run lint
npm run check
npm test
npm run verify
```

---

### Task 1: Define WebSocket V4 As A Realtime-Only Contract

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/unit/client/lib/ws-client-error-code.test.ts`

**Step 1: Write the failing protocol tests**

Add tests that require:
- `hello.protocolVersion === 4`
- v4 rejects older clients with close code `4010`
- v4 server messages do not model `sessions.updated`, `sessions.page`, `sessions.patch`, or `sdk.history`
- `sessions.changed` and `sdk.session.snapshot` exist in the v4 unions

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: FAIL because protocol v4 contracts do not exist yet.

**Step 3: Implement the v4 contract**

In `shared/ws-protocol.ts`, define the new primitives:

```ts
export const WS_PROTOCOL_VERSION = 4 as const

export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

export type SdkSessionSnapshotMessage = {
  type: 'sdk.session.snapshot'
  sessionId: string
  status: SdkSessionStatus
  cliSessionId?: string
  model?: string
  cwd?: string
  tools: Array<{ name: string }>
}
```

In `src/lib/ws-client.ts`, always send `protocolVersion: 4` and treat `4010` as fatal. In `server/ws-handler.ts`, reject clients whose `hello.protocolVersion` does not match `4`.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts test/server/ws-protocol.test.ts test/unit/client/lib/ws-client-error-code.test.ts
git commit -m "feat(protocol): define websocket v4 realtime-only contract"
```

---

### Task 2: Add A Server Read-Model Scheduler With Visible And Background Lanes

**Files:**
- Create: `server/read-model/work-scheduler.ts`
- Test: `test/unit/server/read-model/work-scheduler.test.ts`

**Step 1: Write the failing scheduler tests**

Cover:
- visible jobs start before queued background jobs
- background jobs are capped
- aborted background jobs do not keep running
- a long-running background job does not block a later visible job from starting

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/read-model/work-scheduler.test.ts
```

Expected: FAIL because the scheduler does not exist.

**Step 3: Implement the minimal scheduler**

Create `server/read-model/work-scheduler.ts`:

```ts
export type ReadModelPriority = 'visible' | 'background'

export class ReadModelWorkScheduler {
  run<T>(
    priority: ReadModelPriority,
    job: (signal: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    // Reserve visible capacity and cap background work.
  }
}
```

Rules:
- reserve at least one execution slot for visible work
- allow at most one concurrent background job by default
- drop queued background jobs immediately if the request aborts
- expose cheap queue-depth metrics for logging/assertions

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/read-model/work-scheduler.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/read-model/work-scheduler.ts test/unit/server/read-model/work-scheduler.test.ts
git commit -m "feat(server): add read-model scheduler for visible and background work"
```

---

### Task 3: Build The Server Session Directory Read Model

**Files:**
- Create: `server/session-directory/types.ts`
- Create: `server/session-directory/service.ts`
- Modify: `server/session-search.ts`
- Modify: `server/coding-cli/types.ts`
- Test: `test/unit/server/session-directory/service.test.ts`

**Step 1: Write the failing read-model tests**

Cover:
- stable ordering by `updatedAt desc` plus deterministic tiebreaker
- title search is server-side
- `userMessages` and `fullText` searches come back with bounded snippets
- running terminal metadata is joined server-side
- cursor parsing is deterministic and rejects invalid cursors

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: FAIL because the read model does not exist.

**Step 3: Implement the session directory service**

Create `server/session-directory/service.ts` around the existing indexed project inventory:

```ts
export async function querySessionDirectory(input: {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  cursor?: string
  limit: number
  terminalMeta: TerminalMeta[]
  priority: ReadModelPriority
  signal?: AbortSignal
}): Promise<SessionDirectoryPage> {
  // Flatten, search, join terminal state, cursor, and trim snippets here.
}
```

Implementation requirements:
- reuse `server/session-search.ts` for message/full-text search instead of inventing a second search engine
- keep title search here, not in the client
- return already-sorted, already-joined flat items
- bound snippets and page size on the server

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-directory/types.ts server/session-directory/service.ts server/session-search.ts server/coding-cli/types.ts test/unit/server/session-directory/service.test.ts
git commit -m "feat(server): add session directory read model"
```

---

### Task 4: Define Shared HTTP Contracts And A Single Bootstrap Document

**Files:**
- Create: `shared/http-contracts.ts`
- Create: `server/bootstrap-router.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/bootstrap-router.test.ts`

**Step 1: Write the failing bootstrap tests**

Cover:
- `GET /api/bootstrap` returns settings, platform, version, network, first session directory page, terminal metadata, perf logging, and config fallback
- bootstrap returns the session directory shape, not raw `ProjectGroup[]`

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: FAIL because the route and shared contract do not exist.

**Step 3: Implement the shared contract and router**

In `shared/http-contracts.ts` define:

```ts
export type BootstrapResponse = {
  settings: AppSettings
  platform: {
    platform: string
    availableClis: Record<string, boolean>
    hostName?: string
    featureFlags?: Record<string, boolean>
  }
  version: VersionInfo
  network: NetworkStatus
  sessionDirectory: SessionDirectoryPage
  terminalMeta: TerminalMeta[]
  perfLogging: boolean
  configFallback?: {
    reason: 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR' | 'ENOENT'
    backupExists: boolean
  }
}
```

Create `server/bootstrap-router.ts` and wire it from `server/index.ts`. Build the first session page by calling `querySessionDirectory(...)` with `priority: 'visible'`.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/http-contracts.ts server/bootstrap-router.ts server/index.ts test/integration/server/bootstrap-router.test.ts
git commit -m "feat(bootstrap): serve a single startup document"
```

---

### Task 5: Cut App Startup Over To One Bootstrap Request

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Write the failing startup tests**

Cover:
- App performs one bootstrap request instead of separate settings/platform/version/sessions requests
- bootstrap data seeds session directory and terminal metadata
- the app no longer depends on a websocket session snapshot race during startup

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
```

Expected: FAIL because `App.tsx` still performs a multi-request startup waterfall.

**Step 3: Implement the startup cutover**

In `src/lib/api.ts`, add `getBootstrap()`. In `src/App.tsx`:

```ts
const bootstrap = await api.get<BootstrapResponse>('/api/bootstrap')
dispatch(seedBootstrap(bootstrap))
await ws.connect()
```

Rules:
- delete the separate `/api/settings`, `/api/platform`, `/api/version`, and `/api/sessions?limit=100` startup fetches
- stop requesting terminal metadata separately during initial bootstrap
- preserve auth-failure handling and websocket fatal-error handling

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/api.ts src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
git commit -m "refactor(app): bootstrap from one server-authored document"
```

---

### Task 6: Expose Session Directory Queries Over HTTP And Store Query Windows Client-Side

**Files:**
- Create: `server/session-directory/router.ts`
- Modify: `server/index.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/lib/api.ts`
- Test: `test/integration/server/session-search-api.test.ts`
- Test: `test/unit/client/store/sessionsSlice.test.ts`
- Test: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Write the failing session query tests**

Cover:
- `/api/session-directory` returns cursorable query windows
- invalid cursor/query params are rejected server-side
- client state stores only query windows, revision, and cursors
- local title filtering is no longer part of the slice

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/session-search-api.test.ts
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the new endpoint and query-window state do not exist.

**Step 3: Implement the router and client state**

Create `server/session-directory/router.ts`:

```ts
router.get('/session-directory', async (req, res) => {
  const page = await querySessionDirectory({
    ...parseDirectoryRequest(req),
    priority: req.query.priority === 'background' ? 'background' : 'visible',
    signal: requestAbortSignal(req),
  })
  res.json(page)
})
```

Replace the slice shape in `src/store/sessionsSlice.ts` with:

```ts
type SessionsState = {
  query: SessionDirectoryQuery
  items: SessionDirectoryItem[]
  nextCursor?: string
  totalItems: number
  revision?: number
  loading: boolean
  loadingMore: boolean
}
```

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/session-search-api.test.ts
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-directory/router.ts server/index.ts src/store/sessionsSlice.ts src/lib/api.ts test/integration/server/session-search-api.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "feat(session-directory): expose query windows over http"
```

---

### Task 7: Rewire Sidebar And HistoryView To Server Queries And Abortable Background Fetches

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/Sidebar.render-stability.test.tsx`
- Test: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Write the failing view tests**

Cover:
- search sends `/api/session-directory` requests instead of filtering in memory
- scrolling loads more using the returned cursor
- stale load-more/search requests are aborted when the query changes
- `sessions.changed` invalidation causes a bounded refetch of the current visible window

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because the views still depend on local filtering and raw project snapshots.

**Step 3: Implement the view cutover**

In `Sidebar.tsx` and `HistoryView.tsx`:
- fetch the first page with `priority=visible`
- fetch older pages with `priority=background`
- keep one `AbortController` per active query and cancel it before starting the next request
- keep only expansion state, selection state, and scroll state locally

In `src/App.tsx`, debounce `sessions.changed` and refetch only the active query window.

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/HistoryView.tsx src/App.tsx src/store/selectors/sidebarSelectors.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor(client): render session views from server query windows"
```

---

### Task 8: Store SDK Sessions As Turns Instead Of Flat Replay Arrays

**Files:**
- Create: `server/agent-timeline/types.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`
- Test: `test/unit/server/sdk-bridge-types.test.ts`
- Test: `test/unit/server/sdk-bridge.test.ts`
- Test: `test/unit/server/session-history-loader.test.ts`

**Step 1: Write the failing turn-model tests**

Cover:
- live SDK events fold into deterministic turn records
- resumed `.jsonl` history normalizes into the same turn structure
- recent turns can be marked hydrated while older turns remain summary-only
- `sdk.attach` no longer depends on replaying full history arrays

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: FAIL because server state is still centered on flat `messages: ChatMessage[]`.

**Step 3: Implement the turn model**

Extend `SdkSessionState`:

```ts
interface SdkSessionState {
  sessionId: string
  turns: AgentTurnRecord[]
  timelineRevision: number
  recentExpandedTurnIds: string[]
  // existing status, permissions, questions, and live session metadata remain
}
```

Update `server/session-history-loader.ts` so resumed history is normalized once into turn records, not replay arrays.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/types.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/session-history-loader.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
git commit -m "refactor(sdk): store session state as turns"
```

---

### Task 9: Expose Agent Timeline And Turn Bodies As Read Models

**Files:**
- Create: `server/agent-timeline/service.ts`
- Create: `server/agent-timeline/router.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/agent-timeline/service.test.ts`
- Test: `test/integration/server/agent-timeline-router.test.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Write the failing timeline endpoint tests**

Cover:
- timeline pages are cursorable and deterministic
- recent turns are hydrated first
- older turns return summaries by default
- turn body fetch returns only the requested turn
- websocket attach/create emits `sdk.session.snapshot`, status, permissions, and questions, but not `sdk.history`

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL because the timeline read model and lightweight attach path do not exist.

**Step 3: Implement the timeline service and router**

Create service entry points:

```ts
export function getAgentTimelinePage(input: {
  session: SdkSessionState
  cursor?: string
  limit: number
}): AgentTimelinePage

export function getAgentTurnBody(session: SdkSessionState, turnId: string): AgentTurnBody
```

Wire `server/agent-timeline/router.ts` and update `server/ws-handler.ts` behavior indirectly through the SDK state model:
- `sdk.create` sends `sdk.created`, `sdk.session.snapshot`, and live status
- `sdk.attach` sends `sdk.session.snapshot`, live status, pending permissions/questions, and subscribes to live deltas
- neither path sends `sdk.history`

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/service.ts server/agent-timeline/router.ts server/index.ts test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "feat(agent-chat): expose timeline and turn-body read models"
```

---

### Task 10: Make AgentChatView Viewport-First Instead Of Replay-First

**Files:**
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/agentChatSlice.test.ts`
- Test: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Test: `test/unit/client/components/agent-chat/CollapsedTurn.test.tsx`
- Test: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing agent-chat client tests**

Cover:
- reload shows recent visible turns without counting upward through old history
- expanding older turns fetches bodies on demand
- `sdk.session.snapshot` seeds the live session without `replayHistory`
- stale timeline requests are cancelled on session switch

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because the client still expects `sdk.history` replay semantics.

**Step 3: Implement viewport-first agent chat**

Replace restore state with timeline windows:

```ts
type ChatSessionState = {
  timeline: AgentTurnSummary[]
  hydratedTurnBodies: Record<string, AgentTurnBody>
  nextCursor?: string
  revision?: number
  timelineLoaded: boolean
}
```

Rules:
- fetch the latest timeline page first with `priority=visible`
- fetch older pages and turn bodies only when the user scrolls up or expands
- render `CollapsedTurn` from server-authored summary strings
- keep websocket live status, permission, and question events unchanged

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/sdk-message-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/lib/api.ts test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "refactor(agent-chat): hydrate visible turns before older history"
```

---

### Task 11: Mirror Terminal State On The Server

**Files:**
- Modify: `package.json`
- Create: `server/terminal-view/types.ts`
- Create: `server/terminal-view/mirror.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-view/mirror.test.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

**Step 1: Write the failing terminal mirror tests**

Cover:
- PTY output is mirrored into a headless terminal model
- serialized snapshots are bounded and deterministic
- alternate screen and ANSI-heavy output do not corrupt the mirror
- tail sequence aligns with the broker's live stream

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: FAIL because no terminal mirror exists.

**Step 3: Implement the terminal mirror**

Add the required packages:

```json
"@xterm/headless": "^6.0.0",
"@xterm/addon-serialize": "^0.14.0"
```

Create `server/terminal-view/mirror.ts` with one mirror per terminal fed from raw broker output:

```ts
export class TerminalMirrorRegistry {
  applyOutput(terminalId: string, seqStart: number, data: string): void
  getViewportSnapshot(input: { terminalId: string; cols: number; rows: number }): TerminalViewportSnapshot
}
```

Attach mirror updates where terminal output already becomes sequenced in `server/terminal-stream/broker.ts`.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json server/terminal-view/types.ts server/terminal-view/mirror.ts server/terminal-stream/broker.ts server/terminal-registry.ts test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
git commit -m "feat(terminal): mirror terminal state server-side"
```

---

### Task 12: Expose Terminal Viewport, Scrollback, And Search Read Models

**Files:**
- Create: `server/terminal-view/service.ts`
- Create: `server/terminal-view/router.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/terminal-view-router.test.ts`
- Test: `test/server/terminals-api.test.ts`

**Step 1: Write the failing terminal read-model tests**

Cover:
- `/api/terminals/:terminalId/viewport` returns the current visible screen and `tailSeq`
- `/api/terminals/:terminalId/scrollback` returns bounded older pages
- `/api/terminals/:terminalId/search` returns cursorable server-side search results
- aborted scrollback/search requests stop work early

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: FAIL because the router and service do not exist.

**Step 3: Implement the terminal view service and router**

Create `server/terminal-view/service.ts`:

```ts
export function getTerminalViewport(input: {
  terminalId: string
  cols: number
  rows: number
}): TerminalViewportSnapshot

export function getTerminalScrollbackPage(input: {
  terminalId: string
  cursor?: string
}): TerminalScrollbackPage

export function searchTerminalView(input: {
  terminalId: string
  query: string
  cursor?: string
  signal?: AbortSignal
}): Promise<TerminalSearchResponse>
```

Run viewport work in the visible lane. Run scrollback/search work in the background lane unless the request is for an actively focused search result.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-view/service.ts server/terminal-view/router.ts server/index.ts test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
git commit -m "feat(terminal): expose viewport scrollback and search read models"
```

---

### Task 13: Rework TerminalView To Restore The Viewport First And Search Server-Side

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/unit/client/components/TerminalView.search.test.tsx`
- Test: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Test: `test/e2e/terminal-search-flow.test.tsx`
- Test: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the failing terminal client tests**

Cover:
- mount/reattach fetches `/viewport` first, then attaches from `tailSeq`
- search UI calls the server instead of `SearchAddon`
- stale scrollback/search requests are aborted on terminal switch
- terminal input stays live while background fetches are in flight

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because restore and search are still replay-oriented and client-side.

**Step 3: Implement the viewport-first flow**

Rules:
- fetch `/api/terminals/:terminalId/viewport` before `terminal.attach`
- write the serialized viewport into xterm, then attach with `sinceSeq = tailSeq`
- remove `@xterm/addon-search` from `terminal-runtime.ts`
- fetch older scrollback or search results only on explicit scroll/search actions

Minimal attach flow:

```ts
const snapshot = await api.getTerminalViewport(terminalId, cols, rows)
terminal.reset()
terminal.write(snapshot.serialized)
ws.send({ type: 'terminal.attach', terminalId, cols, rows, sinceSeq: snapshot.tailSeq })
```

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/lib/api.ts src/lib/ws-client.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "refactor(terminal): restore visible viewport before bulk history"
```

---

### Task 14: Delete Legacy Bulk Socket Paths And Enforce Payload Budgets

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/ws-chunking.ts`
- Modify: `src/App.tsx`
- Test: `test/server/ws-handshake-snapshot.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Write the failing cleanup tests**

Cover:
- no v4 handshake or runtime path emits `sessions.updated`, `sessions.page`, or `sessions.patch`
- `sessions.fetch` is gone
- `sdk.history` is absent from create/attach flows
- oversized non-realtime payloads are rejected by design instead of being chunked onto the realtime socket

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because the legacy runtime still exists.

**Step 3: Remove the legacy paths**

Delete or dead-code-eliminate:
- socket session snapshot paging
- `sessions.fetch`
- `broadcastSessionsPatch`
- `broadcastSessionsUpdated`
- `sdk.history` replay
- active runtime use of `server/ws-chunking.ts`

In `server/ws-handler.ts`, enforce:

```ts
const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
```

Any payload that cannot meet that budget must move to HTTP.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/sessions-sync/service.ts server/ws-chunking.ts src/App.tsx test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "refactor(transport): remove legacy bulk websocket runtime"
```

---

### Task 15: Update Docs, Add Slow-Network Regressions, And Run Full Verification

**Files:**
- Modify: `docs/index.html`
- Create: `test/e2e/slow-network-end-to-end.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`
- Modify: `test/e2e/terminal-search-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the final failing regression test**

Add one end-to-end regression that proves the full product promise:
- bootstrap loads from one HTTP document
- session search stays responsive on large datasets
- agent chat restore shows recent turns before older ones
- terminal restore shows current screen without replaying all output
- background history/search requests do not delay terminal input

**Step 2: Run the new regression to verify failure**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx
```

Expected: FAIL until the full cutover is complete.

**Step 3: Update docs and finish regression coverage**

Update `docs/index.html` so the mock reflects:
- server-side session search
- recent-turn-first agent chat restore
- viewport-first terminal restore and server-side terminal search

Strengthen the existing e2e tests to assert abortability and visible-first behavior, not just happy-path rendering.

**Step 4: Run full verification**

```bash
npm run lint
npm run check
npm test
npm run verify
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add docs/index.html test/e2e/slow-network-end-to-end.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "test(docs): lock in slow-network visible-first architecture"
```

## Final Architecture Notes For The Implementer

1. Build on the existing server-side strengths already in the repo:
   - `session-scanner` and `session-search` for session inventory and search
   - `terminal-stream/broker` for sequenced terminal output
   - `sdk-bridge` for live SDK session state
2. Do not recreate client-side derivation logic after introducing server read models. If the UI needs a field, add it to the server response.
3. Prefer refetching the current server window over carrying large client caches and diff logic.
4. Measure response sizes and queue times while implementing. Slow-network work without payload and queue instrumentation is guesswork.
5. Execute tasks in order. The plan assumes direct cutover, not a mixed architecture.
