# Slow-Network Architecture Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace Freshell's client-heavy, bulk-data transport with a server-authoritative, viewport-first architecture that remains responsive on slow links by sending only immediately visible, latency-sensitive data over WebSocket and paging/searching everything else on demand.

**Architecture:** Hard-cut to WebSocket protocol v4. The realtime socket carries only small, latency-sensitive messages: terminal live output after a viewport snapshot, terminal input, attach/detach lifecycle, SDK live deltas, status, permissions, questions, and invalidation hints. All bulk data moves to server-authored HTTP read models: one bootstrap document, one session directory query surface, one agent timeline query surface, and one terminal viewport/scrollback/search surface. The server owns shaping, sorting, summarizing, searching, and pagination; the client holds only the current visible windows and cursors.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, xterm, `@xterm/headless`, `@xterm/addon-serialize`.

---

## Strategy Gate

The current system already has point fixes for chunking, replay, and pagination, but those fixes preserve the wrong architecture:

1. `src/App.tsx` still bootstraps with multiple HTTP requests plus a socket snapshot path, then buffers `sessions.updated` chunks in the browser.
2. `server/ws-handler.ts` still uses WebSocket as a bulk transport for sessions and SDK history, which means low-priority payloads can occupy the same queue as high-priority terminal input/output and attach lifecycle.
3. `src/store/sessionsSlice.ts`, `src/components/Sidebar.tsx`, and `src/components/HistoryView.tsx` still make the browser own too much session shaping, filtering, and merge behavior.
4. `server/ws-handler.ts` + `src/lib/sdk-message-handler.ts` + `src/store/agentChatSlice.ts` still replay full `sdk.history` arrays into Redux on attach/reconnect.
5. `src/components/TerminalView.tsx` still uses client-side xterm search against whatever backlog happened to arrive, which is the opposite of slow-link design.

Do not preserve that model. The correct end state is:

1. WebSocket is a realtime lane only.
2. All bulky data is server-paginated and explicitly requested.
3. The server exposes read models that match UI needs directly.
4. Reconnect restores what the user can see now, not the full historical transcript first.

## Hard-Cutover Rules

1. Bump `WS_PROTOCOL_VERSION` from `3` to `4`.
2. Remove v3 bulk session transport from the socket for v4 clients:
   - no `sessions.updated`
   - no `sessions.page`
   - no `sessions.patch`
3. Remove `sdk.history` replay from `sdk.create` and `sdk.attach` in v4.
4. Bootstrap uses one HTTP request: `GET /api/bootstrap`.
5. Title search is no longer client-side; all session search tiers are server-side.
6. Terminal search is no longer client-side xterm addon search; results come from the server.
7. Realtime socket messages must stay small. Any payload that would routinely exceed the realtime budget belongs on HTTP instead.
8. No backward-compatibility shim after the cutover. Old clients fail fast with `PROTOCOL_MISMATCH`.

## System Invariants

1. Terminal input must never wait behind session snapshots, chat history, or search results.
2. Attach/reconnect must restore a visible screen or visible recent turns first, never replay an entire historical backlog first.
3. The client may cache visible windows, but the server is authoritative for ordering, filtering, cursoring, and search.
4. Offscreen data must be paged, cancellable, and fetched only when the user asks for it or scrolls into it.
5. Slow-link correctness beats local cleverness: if a view needs reconciliation, refetch the current server window instead of rebuilding large client-side state machines.

## Normative Read Models

### Bootstrap

```ts
type BootstrapResponse = {
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
  terminalMeta: TerminalMetaRecord[]
  perfLogging: boolean
  configFallback?: {
    reason: 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR' | 'ENOENT'
    backupExists: boolean
  }
}
```

### Session Directory

```ts
type SessionDirectoryItem = {
  key: string // `${provider}:${sessionId}`
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  projectName: string
  projectColor?: string
  title: string
  subtitle?: string
  summary?: string
  cwd?: string
  updatedAt: number
  createdAt?: number
  archived: boolean
  sessionType?: string
  isRunning: boolean
  runningTerminalId?: string
  snippet?: string
}

type SessionDirectoryPage = {
  revision: number
  query: {
    text: string
    tier: 'title' | 'userMessages' | 'fullText'
    view: 'sidebar' | 'history'
  }
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

Every task below must add targeted red/green tests. The final cutover must also pass all of the following:

1. Protocol tests proving v4 rejects old clients and never emits legacy bulk history/session messages.
2. Server unit tests for each read model service:
   - session directory query/cursoring/search
   - agent timeline turn materialization
   - terminal viewport/scrollback/search generation
3. Server integration tests for each HTTP surface:
   - `/api/bootstrap`
   - `/api/session-directory`
   - `/api/agent-sessions/:sessionId/timeline`
   - `/api/agent-sessions/:sessionId/turns/:turnId`
   - `/api/terminals/:terminalId/viewport`
   - `/api/terminals/:terminalId/scrollback`
   - `/api/terminals/:terminalId/search`
4. Client unit tests proving:
   - `App` bootstraps from one HTTP document
   - Sidebar/HistoryView no longer do local title filtering
   - Agent chat no longer stores full history arrays on attach
   - Terminal search uses server results, not `SearchAddon`
5. E2E tests on mocked slow/flaky transport proving:
   - startup becomes interactive before offscreen history loads
   - reconnect restores latest visible state without historical playback
   - terminal input remains responsive while background bulk fetches are in flight
   - session search returns results without shipping full datasets to the client
6. Full suite before merge:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

---

### Task 1: Define WebSocket V4 As A Realtime-Only Transport

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/server/ws-protocol-v4.test.ts`
- Test: `test/unit/client/lib/ws-client.v4.test.ts`

**Step 1: Write failing protocol tests**

Add tests that require:

1. `hello.protocolVersion === 4`
2. v4 server never emits `sessions.updated`, `sessions.page`, `sessions.patch`, or `sdk.history`
3. `sdk.attach` returns a lightweight snapshot/status path only
4. `sessions.changed` invalidation exists for v4
5. protocol mismatch remains fatal with close code `4010`

**Step 2: Run targeted tests to verify failure**

```bash
npm run test:server -- test/server/ws-protocol-v4.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.v4.test.ts
```

Expected: FAIL because protocol v4 contracts do not exist yet.

**Step 3: Implement the v4 contract**

In `shared/ws-protocol.ts`:

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
  tools?: Array<{ name: string }>
}
```

Update the server/client unions so v4 no longer models `sdk.history` or socket session snapshot paging as active transport behavior.

In `src/lib/ws-client.ts`, send `protocolVersion: 4` and treat `4010` as fatal.

In `server/ws-handler.ts`, reject non-v4 clients and stop emitting the legacy bulk session/history messages for v4 paths.

**Step 4: Run targeted tests to verify pass**

```bash
npm run test:server -- test/server/ws-protocol-v4.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.v4.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts test/server/ws-protocol-v4.test.ts test/unit/client/lib/ws-client.v4.test.ts
git commit -m "feat(protocol): make websocket v4 realtime-only"
```

---

### Task 2: Build The Server-Authored Session Directory Read Model

**Files:**
- Create: `server/session-directory/types.ts`
- Create: `server/session-directory/service.ts`
- Create: `server/session-directory/router.ts`
- Modify: `server/index.ts`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/sessions-router.ts`
- Test: `test/unit/server/session-directory/service.test.ts`
- Test: `test/integration/server/session-directory-router.test.ts`

**Step 1: Write failing query/cursor/search tests**

Cover:

1. stable cursor ordering by recency + composite key
2. server-side title search replacing client-side title filter
3. `userMessages` and `fullText` search reuse the same server path
4. running-terminal metadata is joined server-side
5. result snippets are server-authored and bounded

**Step 2: Run targeted server tests**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
```

Expected: FAIL because the directory read model and endpoint do not exist.

**Step 3: Implement the read model and router**

Create `server/session-directory/service.ts` with one entry point:

```ts
export function querySessionDirectory(input: {
  projects: ProjectGroup[]
  terminalMeta: TerminalMeta[]
  query: { text: string; tier: 'title' | 'userMessages' | 'fullText'; view: 'sidebar' | 'history' }
  cursor?: string
  limit: number
}): Promise<SessionDirectoryPage>
```

Rules:

1. all searching lives on the server, including title search
2. output items are flat, already sorted, and already joined with running-terminal state
3. snippets are pre-trimmed server-side
4. cursor parsing/validation lives here, not in the client

Expose `GET /api/session-directory`.

Keep `server/sessions-router.ts` only for rename/delete/session metadata mutation paths; stop treating it as the primary session list/query surface.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-directory/types.ts server/session-directory/service.ts server/session-directory/router.ts server/index.ts server/coding-cli/types.ts server/sessions-router.ts test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
git commit -m "feat(server): add session directory read model"
```

---

### Task 3: Replace Multi-Request Bootstrap With A Single Server Bootstrap Document

**Files:**
- Create: `shared/http-contracts.ts`
- Create: `server/bootstrap-router.ts`
- Modify: `server/index.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/App.tsx`
- Test: `test/integration/server/bootstrap-router.test.ts`
- Test: `test/unit/client/components/App.bootstrap.test.tsx`

**Step 1: Write failing bootstrap tests**

Cover:

1. `GET /api/bootstrap` returns settings, platform, version, network, session directory first page, terminal meta, perf logging, and config fallback
2. `App` does one bootstrap HTTP request instead of separate settings/platform/version/sessions requests
3. socket readiness no longer depends on an HTTP `/api/sessions?limit=100` race

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.bootstrap.test.tsx
```

Expected: FAIL because the bootstrap route and client cutover do not exist.

**Step 3: Implement the bootstrap aggregator**

Create `shared/http-contracts.ts` for shared REST response types and Zod schemas.

Create `server/bootstrap-router.ts`:

```ts
router.get('/bootstrap', async (_req, res) => {
  res.json(await buildBootstrapResponse())
})
```

In `src/App.tsx`, replace the multi-request bootstrap sequence with:

1. `GET /api/bootstrap`
2. apply settings/platform/version/network/session directory/terminal meta from that one payload
3. connect WebSocket

Delete the browser-side chunked session bootstrap buffering path from startup; that path belongs to legacy socket snapshots and must not survive the cutover.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/http-contracts.ts server/bootstrap-router.ts server/index.ts src/lib/api.ts src/App.tsx test/integration/server/bootstrap-router.test.ts test/unit/client/components/App.bootstrap.test.tsx
git commit -m "feat(bootstrap): aggregate startup data server-side"
```

---

### Task 4: Rewire Sidebar And HistoryView To The Session Directory Query Surface

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Test: `test/unit/client/components/App.test.tsx`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Write failing client tests**

Cover:

1. title search goes through `GET /api/session-directory`, not local filtering
2. infinite scroll uses server cursors
3. `sessions.changed` invalidation triggers a bounded refetch of the current query window
4. `HistoryView` refresh uses the new query surface
5. rename/delete still work without reintroducing the old raw-project bootstrap

**Step 2: Run targeted client tests**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/App.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because the UI still depends on raw `ProjectGroup[]` snapshots and local search.

**Step 3: Implement the client cutover**

In `src/store/sessionsSlice.ts`, replace bulk-project snapshot semantics with query-window state:

```ts
type SessionsState = {
  query: { text: string; tier: 'title' | 'userMessages' | 'fullText'; view: 'sidebar' | 'history' }
  items: SessionDirectoryItem[]
  nextCursor?: string
  totalItems: number
  loading: boolean
  loadingMore: boolean
  revision?: number
}
```

In `src/components/Sidebar.tsx` and `src/components/HistoryView.tsx`:

1. fetch server pages via `searchSessionDirectory(...)`
2. drop local title filtering
3. preserve only UI-local concerns client-side: expansion state, selection state, scroll position

In `src/App.tsx`, handle `sessions.changed` by refetching the active query window after a short debounce.

**Step 4: Run targeted tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/App.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx src/App.tsx src/lib/api.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/App.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor(client): use server session directory queries"
```

---

### Task 5: Materialize Agent Sessions As A Server Timeline With Summaries And Bodies

**Files:**
- Create: `server/agent-timeline/types.ts`
- Create: `server/agent-timeline/service.ts`
- Create: `server/agent-timeline/router.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/agent-timeline/service.test.ts`
- Test: `test/integration/server/agent-timeline-router.test.ts`
- Test: `test/server/ws-handler-sdk.test.ts`

**Step 1: Write failing timeline tests**

Cover:

1. SDK messages are grouped into stable turn records
2. older turns are returned as summaries, not full bodies, by default
3. recent turns are returned hydrated
4. resumed sessions loaded from `.jsonl` are normalized into the same turn model
5. timeline/body endpoints are cursorable and deterministic
6. `sdk.attach` no longer requires `sdk.history`

**Step 2: Run targeted tests**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/server/ws-handler-sdk.test.ts
```

Expected: FAIL because the server still stores plain message arrays and replays them wholesale.

**Step 3: Implement the timeline service**

Extend `SdkSessionState` so the server stores turns, not only flat messages:

```ts
interface SdkSessionState {
  ...
  turns: AgentTurnRecord[]
  timelineRevision: number
}
```

Create `server/agent-timeline/service.ts` to:

1. fold live SDK events into turns
2. produce `AgentTimelinePage`
3. return `AgentTurnBody`
4. build summaries server-side so `CollapsedTurn` stops inventing them from locally replayed full messages

Expose:

1. `GET /api/agent-sessions/:sessionId/timeline`
2. `GET /api/agent-sessions/:sessionId/turns/:turnId`

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/server/ws-handler-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/types.ts server/agent-timeline/service.ts server/agent-timeline/router.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/session-history-loader.ts server/index.ts test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/server/ws-handler-sdk.test.ts
git commit -m "feat(agent-chat): add server timeline read model"
```

---

### Task 6: Remove Full `sdk.history` Replay And Make AgentChatView Viewport-First

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/agentChatSlice.test.ts`
- Test: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Test: `test/e2e/agent-chat-slow-network-hydration.test.tsx`

**Step 1: Write failing client tests**

Cover:

1. attach/reload shows recent visible turns without waiting for full history replay
2. older turns expand by fetching turn bodies from HTTP
3. session restore no longer dispatches `replayHistory`
4. reconnect keeps live status/permission behavior intact
5. the UI no longer shows old turns "counting up" during restore

**Step 2: Run targeted tests**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-slow-network-hydration.test.tsx
```

Expected: FAIL because the client still expects full `sdk.history`.

**Step 3: Implement the attach/reload cutover**

In `server/ws-handler.ts`:

1. `sdk.create` and `sdk.attach` send `sdk.session.snapshot`, status, pending permissions, pending questions, and model info
2. they do not send `sdk.history`

In `src/store/agentChatSlice.ts`, replace `messages: ChatMessage[]` as the primary restore representation with:

```ts
type ChatSessionState = {
  ...
  timeline: AgentTurnSummary[]
  hydratedTurnBodies: Record<string, AgentTurnBody>
  timelineLoaded?: boolean
}
```

In `AgentChatView.tsx`:

1. fetch `/api/agent-sessions/:sessionId/timeline?cursor=tail`
2. keep recent turns expanded
3. fetch `/turns/:turnId` only when the user expands an older turn or scrolls into older history

`CollapsedTurn.tsx` should render the server-authored summary string instead of inventing one from already-loaded full bodies.

**Step 4: Run targeted tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-slow-network-hydration.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts src/lib/sdk-message-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/lib/api.ts test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-slow-network-hydration.test.tsx
git commit -m "refactor(agent-chat): restore timeline windows instead of full history replay"
```

---

### Task 7: Build A Server Terminal Viewport, Scrollback, And Search Service

**Files:**
- Modify: `package.json`
- Create: `server/terminal-view/types.ts`
- Create: `server/terminal-view/mirror.ts`
- Create: `server/terminal-view/service.ts`
- Create: `server/terminal-view/router.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/terminal-view/mirror.test.ts`
- Test: `test/integration/server/terminal-view-router.test.ts`

**Step 1: Write failing terminal-view tests**

Cover:

1. PTY output is mirrored into a server-side terminal model
2. viewport snapshots return bounded serialized content plus `tailSeq`
3. scrollback pages are bounded and cursorable
4. search results come from server-side mirrored content
5. ANSI-heavy output and alternate-screen transitions do not corrupt the mirror

**Step 2: Run targeted tests**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/integration/server/terminal-view-router.test.ts
```

Expected: FAIL because no terminal view service exists.

**Step 3: Implement the mirror/service/router**

Add dependencies:

```json
"@xterm/headless": "^6.0.0",
"@xterm/addon-serialize": "^0.14.0"
```

In `server/terminal-view/mirror.ts`, maintain a headless terminal mirror per terminal and feed it from `terminal.output.raw`.

Expose:

1. `GET /api/terminals/:terminalId/viewport?cols=...&rows=...`
2. `GET /api/terminals/:terminalId/scrollback?cursor=...`
3. `GET /api/terminals/:terminalId/search?q=...&cursor=...`

The viewport path must return serialized content plus the sequence watermark the client should attach from:

```ts
return {
  terminalId,
  revision,
  cols,
  rows,
  tailSeq,
  serialized,
  hasOlderScrollback,
  scrollbackCursor,
}
```

**Step 4: Run targeted tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/integration/server/terminal-view-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json server/terminal-view/types.ts server/terminal-view/mirror.ts server/terminal-view/service.ts server/terminal-view/router.ts server/terminal-registry.ts server/terminal-stream/broker.ts server/index.ts test/unit/server/terminal-view/mirror.test.ts test/integration/server/terminal-view-router.test.ts
git commit -m "feat(terminal): add server viewport and scrollback read model"
```

---

### Task 8: Rework TerminalView To Fetch Viewports And Use Server-Side Search

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/unit/client/components/TerminalView.search.test.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/e2e/terminal-search-flow.test.tsx`
- Test: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write failing terminal client tests**

Cover:

1. mount/reattach fetches `/api/terminals/:id/viewport` first, then sends `terminal.attach` with `sinceSeq = tailSeq`
2. search UI hits the server endpoint, not `SearchAddon`
3. live output continues from the fetched watermark without replaying the old buffer
4. while a scrollback/search request is in flight, terminal input still sends immediately

**Step 2: Run targeted tests**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because TerminalView still uses client-side search and replay-oriented attach logic.

**Step 3: Implement the viewport-first client flow**

In `TerminalView.tsx`:

1. fetch viewport before attach
2. reset the browser xterm instance and write `serialized`
3. attach from `tailSeq`
4. on scrollback/search result selection, fetch bounded server snapshots instead of trying to replay everything locally

In `terminal-runtime.ts`, remove `@xterm/addon-search` usage from the runtime contract. Searching becomes an async API call from the component layer.

**Step 4: Run targeted tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/lib/api.ts src/lib/ws-client.ts test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "refactor(terminal): hydrate viewport first and move search server-side"
```

---

### Task 9: Delete Legacy Bulk Socket Paths And Enforce Realtime Queue Budgets

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/ws-chunking.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `src/App.tsx`
- Modify: `src/store/sessionsSlice.ts`
- Test: `test/server/ws-handshake-snapshot.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Write failing cleanup tests**

Cover:

1. no v4 handshake/session bootstrap path emits chunked session snapshots
2. `sdk.history` is absent from attach/create flows
3. oversized non-realtime payloads are rejected by design instead of being chunked onto the realtime socket
4. `App` no longer contains the chunked session buffer/reconciliation logic

**Step 2: Run targeted tests**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx
```

Expected: FAIL because legacy transport code is still present.

**Step 3: Remove the legacy paths**

Delete or dead-code-eliminate the following concepts from the active runtime:

1. chunked `sessions.updated` transport
2. `sessions.page` socket pagination
3. browser-side chunk buffer assembly in `App.tsx`
4. `sdk.history` replay on create/attach
5. realtime use of `server/ws-chunking.ts` and `server/session-pagination.ts`

Add a strict realtime payload budget in `server/ws-handler.ts`:

```ts
const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
```

Anything that cannot meet that budget belongs on HTTP.

**Step 4: Run targeted tests to verify pass**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/sessions-sync/service.ts server/session-pagination.ts server/ws-chunking.ts server/session-history-loader.ts src/App.tsx src/store/sessionsSlice.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/client/components/App.test.tsx
git commit -m "refactor(transport): remove legacy bulk websocket paths"
```

---

### Task 10: Update Docs, Add Slow-Link Regression Coverage, And Run Full Verification

**Files:**
- Modify: `docs/index.html`
- Create: `test/e2e/slow-network-end-to-end.test.tsx`
- Modify: `test/e2e/agent-chat-slow-network-hydration.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Write the final failing regression tests**

Add one end-to-end regression that covers the actual product promise:

1. bootstrap loads from one HTTP document
2. sidebar search stays responsive on large datasets
3. agent chat restore shows recent visible turns before older data
4. terminal reconnect shows current screen without replaying all output
5. background bulk requests do not delay terminal input

**Step 2: Run the new regression test**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx
```

Expected: FAIL until the full cutover is complete.

**Step 3: Update the docs/mock and finalize verification**

Update `docs/index.html` so the mock reflects:

1. server-side search
2. recent-turn-first restore in agent chat
3. viewport-first terminal restore/search

Then run the full verification suite:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

**Step 4: Commit**

```bash
git add docs/index.html test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-slow-network-hydration.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test(docs): lock in slow-network architecture cutover"
```

## Final Architecture Notes For The Implementer

1. Resist partial compatibility work. The old socket bulk paths are the bug, not an asset.
2. Keep the server read models narrow and explicit. If the UI needs a new field, add it on the server instead of rebuilding local derivation logic.
3. Favor refetching the active window over keeping a giant client cache synchronized.
4. Measure every bulk response size and every realtime message size while implementing. Slow-network architecture without observability is guesswork.
5. Do not stop after targeted tests. The value of this plan is the final slow-link behavior under full-suite verification.
