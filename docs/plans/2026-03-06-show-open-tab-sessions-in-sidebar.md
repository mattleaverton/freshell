# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a local tab is included in the authoritative initial sidebar snapshot even when it is older than the normal 100-session first page.

**Architecture:** Fix the authoritative first-page selection path instead of adding a second client-side hydration system. The client will send the set of open tab session locators to the two baseline producers that already seed sidebar state today: the initial HTTP bootstrap request and the websocket handshake snapshot; the server will extend `paginateProjects()` so the first page is the normal newest-100 window plus any matching open local sessions, while keeping the pagination cursor anchored to the normal 100-session boundary so page 2 does not skip sessions. After that first baseline lands, the existing `mergeSnapshotProjects()` behavior in `src/store/sessionsSlice.ts` continues preserving those extra sessions across later paginated snapshots.

**Tech Stack:** React 18, Redux Toolkit, Express, Zod, Vitest, Testing Library

---

**Notes:**
- Work in `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`.
- This plan intentionally replaces the previous client-side hydration direction. Do not add `POST /sessions/resolve`, `mergeResolvedProjects()`, or any App retry/parking effect.
- Do not use `lastLoadedAt` as a retry or baseline token. Its current semantics are broader than “authoritative baseline” and do not need to change for this feature.
- Only local sessions are force-included into the first page: locators with no `serverInstanceId`, or locators whose `serverInstanceId` matches this server's `serverInstanceId`.
- Legacy clients that do not advertise sessions pagination already receive the full session list over websocket and need no special handling.
- When force-included sessions are older than the normal page boundary, `oldestIncludedTimestamp` and `oldestIncludedSessionId` must continue to describe the next-page cursor for the primary 100-session window, not the literal oldest returned forced extra. Add comments and tests that make this explicit.
- `docs/index.html` does not need an update because the UI layout does not change.

### Task 1: Extract Shared Open-Session Locator Collection

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/lib/session-utils.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Step 1: Write the failing tests**

In `test/unit/client/lib/session-utils.test.ts`, add focused coverage for a new helper that walks tabs plus pane layouts and returns the best deduped locator for each open session key:

```typescript
expect(collectSessionLocatorsFromTabs(tabs, panes, { localServerInstanceId: 'srv-local' })).toEqual([
  { provider: 'codex', sessionId: 'local-codex', serverInstanceId: 'srv-local' },
  { provider: 'codex', sessionId: 'remote-only', serverInstanceId: 'srv-remote' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])

expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'local-codex' },
  { provider: 'codex', sessionId: 'remote-only' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])
```

Cover:
- pane-level explicit `sessionRef` preserving `serverInstanceId`
- terminal and `agent-chat` panes
- legacy tab-level `resumeSessionId` fallback when no layout exists
- duplicate `provider:sessionId` across panes and tabs
- local-vs-foreign duplicate preference when the same session appears in both forms
- invalid Claude IDs ignored the same way existing helpers ignore them

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add a small regression proving `buildSessionItems()` still marks `hasTab` correctly after it switches to the shared helper for pane-backed tabs and tabs without layouts.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: FAIL because the shared tab-level locator collector does not exist yet.

**Step 3: Implement the shared helpers**

In `src/lib/session-utils.ts`:
- add `extractSessionLocator()` that preserves explicit `sessionRef.serverInstanceId`
- add `collectSessionLocatorsFromNode()` and `collectSessionLocatorsFromTabs()`
- keep `collectSessionRefsFromNode()` and `collectSessionRefsFromTabs()` as thin wrappers that strip `serverInstanceId`
- add a small priority helper so duplicate keys prefer the local locator when both local and foreign variants exist

Use this shape:

```typescript
function locatorPriority(locator: SessionLocator, localServerInstanceId?: string): number {
  if (localServerInstanceId && locator.serverInstanceId === localServerInstanceId) return 3
  if (!locator.serverInstanceId) return 2
  return 1
}
```

Then refactor `src/store/selectors/sidebarSelectors.ts` so `buildSessionItems()` calls `collectSessionRefsFromTabs(tabs, panes)` instead of traversing tabs inline.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "refactor: share open-tab session locator collection"
```

### Task 2: Teach `paginateProjects()` To Force-Include Open Sessions On The First Page

**Files:**
- Modify: `server/session-pagination.ts`
- Modify: `test/unit/server/session-pagination.test.ts`

**Step 1: Write the failing pagination tests**

Extend `test/unit/server/session-pagination.test.ts` with cases for:
- a first page with `limit: 100` returns the normal newest 100 sessions plus an older explicitly force-included session outside that window
- force-including a session already inside the newest 100 does not duplicate it
- force-included sessions are ignored when `before`/`beforeId` request a later page
- the next-page cursor remains anchored to the primary 100-session window, so page 2 still returns the sessions immediately after that window and does not skip over anything because of an ancient forced extra

Use an explicit cursor test like:

```typescript
const page1 = paginateProjects(projects, {
  limit: 2,
  forceIncludeSessionKeys: new Set(['claude:very-old-open']),
})

expect(page1.projects.flatMap((p) => p.sessions).map((s) => s.sessionId)).toEqual([
  'newest',
  'second-newest',
  'very-old-open',
])
expect(page1.oldestIncludedSessionId).toBe('claude:second-newest')

const page2 = paginateProjects(projects, {
  limit: 2,
  before: page1.oldestIncludedTimestamp,
  beforeId: page1.oldestIncludedSessionId,
})

expect(page2.projects.flatMap((p) => p.sessions).map((s) => s.sessionId)).toEqual([
  'third-newest',
  'fourth-newest',
])
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/session-pagination.test.ts
```

Expected: FAIL because `paginateProjects()` cannot force-include first-page session keys yet.

**Step 3: Implement force-included first-page selection**

In `server/session-pagination.ts`:
- extend `PaginateOptions` with `forceIncludeSessionKeys?: ReadonlySet<string>`
- keep the existing global recency ordering and cursor filtering
- on the first page only (`before === undefined && beforeId === undefined`), take the normal recency window first, then union in any matching `forceIncludeSessionKeys` not already present
- keep `totalSessions` and `hasMore` based on the canonical catalog, not the inflated returned row count
- keep `oldestIncludedTimestamp` and `oldestIncludedSessionId` tied to the primary recency window
- update the interface comment so those fields are documented as the next-page cursor when force-included sessions are present

Use this structure:

```typescript
const primaryPage = filteredSessions.slice(0, limit)
const primaryKeys = new Set(primaryPage.map(cursorKey))
const forcedExtras = isFirstPage && options.forceIncludeSessionKeys?.size
  ? filteredSessions.filter((session) => (
      options.forceIncludeSessionKeys!.has(cursorKey(session)) && !primaryKeys.has(cursorKey(session))
    ))
  : []

const selected = [...primaryPage, ...forcedExtras].sort(compareSessionsDesc)
const cursor = primaryPage.at(-1)
```

Then regroup `selected` back into `ProjectGroup[]`, preserving project colors.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/session-pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/session-pagination.ts test/unit/server/session-pagination.test.ts
git commit -m "feat: force include open sessions on the first page"
```

### Task 3: Thread Open Session Locators Through The HTTP Bootstrap Path

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `server/index.ts`
- Modify: `src/App.tsx`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing HTTP bootstrap tests**

In `test/unit/server/sessions-router-pagination.test.ts`, add cases for:
- `GET /sessions?limit=100&openSession=...` returns the normal first page plus the older requested local session
- the same request ignores a foreign-only locator whose `serverInstanceId` does not match this server
- the next-page cursor from that force-included first page still pages correctly
- invalid `openSession` query values return `400`
- `GET /sessions` without pagination params still returns the raw array for backward compatibility

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, add cases for:
- the initial sessions bootstrap request includes the open-tab locators from tabs/panes
- the pre-connected websocket fallback refetch uses the same request shape
- the request preserves explicit `sessionRef.serverInstanceId` so the server can reject foreign copied-tab sessions

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: FAIL because neither the router nor `App` currently threads open session locators through the HTTP baseline request.

**Step 3: Implement HTTP bootstrap force-inclusion**

In `server/index.ts`, pass `serverInstanceId` into `createSessionsRouter(...)`.

In `server/sessions-router.ts`:
- add a parser for repeated `openSession` query params
- parse each `openSession` value as JSON and validate it with a small Zod schema matching `{ provider, sessionId, serverInstanceId? }`
- convert the validated locators into a `Set<string>` of local session keys by dropping any locator whose explicit `serverInstanceId` does not match `deps.serverInstanceId`
- pass that set into `paginateProjects()` as `forceIncludeSessionKeys`

Keep the route behavior narrow:
- force inclusion only matters on paginated requests
- raw `GET /sessions` without pagination params still returns the legacy raw array

Use this kind of parsing flow:

```typescript
const rawOpen = req.query.openSession
const rawValues = rawOpen === undefined ? [] : Array.isArray(rawOpen) ? rawOpen : [rawOpen]

const openLocators = rawValues.map((value) => OpenSessionLocatorSchema.parse(JSON.parse(String(value))))
const forceIncludeSessionKeys = new Set(
  openLocators
    .filter((locator) => !locator.serverInstanceId || locator.serverInstanceId === deps.serverInstanceId)
    .map((locator) => `${locator.provider}:${locator.sessionId}`)
)
```

In `src/App.tsx`, factor the repeated initial/fallback sessions fetch into a helper that reads the restored tabs and panes from `store.getState()`, collects locators with `collectSessionLocatorsFromTabs(...)`, and builds the request path:

```typescript
function buildInitialSessionsPath(): string {
  const state = store.getState()
  const params = new URLSearchParams({ limit: '100' })
  for (const locator of collectSessionLocatorsFromTabs(state.tabs.tabs, state.panes)) {
    params.append('openSession', JSON.stringify(locator))
  }
  return `/api/sessions?${params}`
}
```

Use that helper for:
- the first bootstrap fetch
- the pre-connected websocket fallback refetch

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/index.ts server/sessions-router.ts src/App.tsx test/unit/server/sessions-router-pagination.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: include open tab sessions in the bootstrap page"
```

### Task 4: Thread Open Session Locators Through Websocket Hello And Handshake Snapshot

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/App.tsx`
- Modify: `server/ws-handler.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing websocket tests**

In `test/server/ws-handshake-snapshot.test.ts`, add cases for:
- a pagination-capable client whose `hello` includes an older local open session receives that session in the handshake `sessions.updated` snapshot even though it is outside the newest 100
- a foreign-only locator is ignored
- a legacy client without pagination capability still gets the full snapshot and needs no `sidebarOpenSessions`

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, extend the existing hello extension test so the provider now returns both:
- `sessions` for session repair prioritization
- `sidebarOpenSessions` for first-page inclusion

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts
```

Expected: FAIL because hello messages and handshake snapshots do not carry or use open-tab session locators yet.

**Step 3: Implement websocket first-page inclusion**

In `shared/ws-protocol.ts`, add a shared locator schema and extend `HelloSchema`:

```typescript
export const SessionLocatorSchema = z.object({
  provider: CodingCliProviderSchema,
  sessionId: z.string().min(1),
  serverInstanceId: z.string().min(1).optional(),
})

export const HelloSchema = z.object({
  // ...
  sessions: z.object({
    active: z.string().optional(),
    visible: z.array(z.string()).optional(),
    background: z.array(z.string()).optional(),
  }).optional(),
  sidebarOpenSessions: z.array(SessionLocatorSchema).max(200).optional(),
})
```

In `src/lib/ws-client.ts`, extend `HelloExtensionProvider` so it can return `sidebarOpenSessions`.

In `src/App.tsx`, update the existing hello extension provider to include:

```typescript
ws.setHelloExtensionProvider(() => {
  const state = store.getState()
  return {
    sessions: getSessionsForHello(state),
    sidebarOpenSessions: collectSessionLocatorsFromTabs(state.tabs.tabs, state.panes),
    client: { mobile: isMobileRef.current },
  }
})
```

In `server/ws-handler.ts`:
- extend `ClientState` with `sidebarOpenSessionKeys: Set<string>`
- on `hello`, validate `m.sidebarOpenSessions`, drop any explicit foreign locator whose `serverInstanceId` does not match `this.serverInstanceId`, and store the remaining composite keys in `state.sidebarOpenSessionKeys`
- in `sendHandshakeSnapshot()`, when the client supports pagination, call:

```typescript
const paginated = paginateProjects(snapshot.projects, {
  limit: 100,
  forceIncludeSessionKeys: state.sidebarOpenSessionKeys,
})
```

Do not change `broadcastSessionsUpdated()` for already-connected clients. Once the first authoritative baseline includes the open-tab session, the existing client-side `mergeSnapshotProjects()` path already preserves it across later paginated snapshots.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add shared/ws-protocol.ts src/lib/ws-client.ts src/App.tsx server/ws-handler.ts test/server/ws-handshake-snapshot.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: include open tab sessions in handshake snapshots"
```

### Task 5: Add A User-Visible Regression And Run Full Verification

**Files:**
- Create: `test/e2e/app-open-tab-session-first-page.test.tsx`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Write the failing regression tests**

Create `test/e2e/app-open-tab-session-first-page.test.tsx` covering the user-visible flow:
- seed the store with a tab/pane that points at an older session
- mock the sessions bootstrap endpoint so it returns the server-style first page only when the request includes the expected `openSession` locator
- use a lightweight mocked `Sidebar` that reads `state.sessions.projects` and renders the visible session titles
- assert that the older open-tab session appears immediately without scroll or search

Sketch:

```typescript
await waitFor(() => {
  expect(screen.getByText('Older open tab session')).toBeInTheDocument()
})

const sessionsCalls = mockApiGet.mock.calls
  .map(([url]) => String(url))
  .filter((url) => url.startsWith('/api/sessions?'))

expect(sessionsCalls[0]).toContain('openSession=')
```

Also add one explicit reducer-level regression in `test/unit/client/store/sessionsSlice.test.ts` if needed to name the invariant this feature relies on: a later paginated `mergeSnapshotProjects()` snapshot preserves an older session that was already present in state but is outside the latest paginated window.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/app-open-tab-session-first-page.test.tsx test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because the new bootstrap request shape and rendered behavior are not fully covered yet.

**Step 3: Finish any missing wiring revealed by the regression**

If the e2e regression needs minor harness changes, keep them inside the test file:
- mocked `Sidebar` should render session titles from Redux
- mocked `api.get` should parse the bootstrap URL and only return the older session when the request carries the correct locator

Do not add new product behavior in this step unless the regression reveals a real missing piece from Tasks 1-4.

**Step 4: Run regression, lint, and the full test suite**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/app-open-tab-session-first-page.test.tsx test/unit/client/store/sessionsSlice.test.ts
npm run lint
npm test
```

Expected: PASS for all commands.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/app-open-tab-session-first-page.test.tsx test/unit/client/store/sessionsSlice.test.ts
git commit -m "test: cover open tab sessions in the first page"
```
