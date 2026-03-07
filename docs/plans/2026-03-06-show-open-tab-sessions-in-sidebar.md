# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure every session that is already open in a local tab appears in the left sidebar even when it falls outside the initial 100-session paginated window.

**Architecture:** Keep the existing paginated `/api/sessions?limit=100` and websocket snapshot contracts unchanged. After the first authoritative server baseline lands, `App` will collect the open local session locators from tabs and panes, exact-resolve only the missing local sessions through a new lookup endpoint, and merge the returned sessions into `state.sessions.projects` with a reducer that never mutates server-baseline freshness markers. Use `sessions.lastLoadedAt` only as the retry token for authoritative server-driven updates, which means the new local merge reducer must not touch `lastLoadedAt`, `wsSnapshotReceived`, or pagination metadata.

**Tech Stack:** React 18, Redux Toolkit, Express, Zod, Vitest, Testing Library

---

**Notes:**
- Work in `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`.
- Do not change the shape of `GET /api/sessions` or any websocket session payload for this feature.
- Do not synthesize sidebar-only fake sessions. Hydrate missing local open-tab sessions into canonical `state.sessions.projects` instead.
- Only hydrate sessions that are local to this Freshell server: either the tab has no `serverInstanceId`, or `sessionRef.serverInstanceId === state.connection.serverInstanceId`. Foreign copied-tab locators stay tab-only because the local sidebar cannot authoritatively manufacture their metadata.
- `mergeSnapshotProjects()` already preserves older sessions when `hasMore === true`; keep that invariant explicit with tests so later paginated baselines never drop hydrated open-tab sessions.
- No `docs/index.html` update is needed because the UI layout does not change.

### Task 1: Extract Shared Open-Session Locator Collection

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/lib/session-utils.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Step 1: Write the failing tests**

In `test/unit/client/lib/session-utils.test.ts`, add coverage for a new helper that walks tabs plus pane layouts and returns the best deduped locator for each open session key:

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
- duplicate `provider:sessionId` across multiple tabs and panes
- local-vs-foreign duplicate preference when the same session appears in both forms
- invalid Claude IDs ignored the same way the existing helpers ignore them

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add a small regression proving `buildSessionItems()` still marks `hasTab` from the shared helper for both pane-backed tabs and legacy tabs-without-layout.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: FAIL because the new tab-level locator collector does not exist yet.

**Step 3: Implement the shared helpers and refactor sidebar tab detection**

In `src/lib/session-utils.ts`:
- Add `extractSessionLocator()` that preserves explicit `sessionRef.serverInstanceId`.
- Add `collectSessionLocatorsFromNode()` and `collectSessionLocatorsFromTabs()`.
- Keep `collectSessionRefsFromNode()` as the server-instance-id-stripping wrapper used by existing call sites.
- Add a small local-priority helper so duplicate keys prefer the local locator:

```typescript
function locatorPriority(locator: SessionLocator, localServerInstanceId?: string): number {
  if (localServerInstanceId && locator.serverInstanceId === localServerInstanceId) return 3
  if (!locator.serverInstanceId) return 2
  return 1
}
```

In `src/store/selectors/sidebarSelectors.ts`, replace the inline tab traversal in `buildSessionItems()` with `collectSessionRefsFromTabs(tabs, panes)`. This keeps the selector behavior unchanged while giving `App` a single source of truth for the open-session locator list it will hydrate in Task 4.

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

### Task 2: Add Exact Session Resolve API And Client Helper

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `src/lib/api.ts`
- Create: `test/unit/server/sessions-router.resolve.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing server and client tests**

Create `test/unit/server/sessions-router.resolve.test.ts` covering:
- `POST /sessions/resolve` returns only the requested sessions, grouped by project and preserving project colors
- duplicate request entries are deduped
- missing sessions are ignored instead of failing the whole request
- malformed bodies and oversized batches return `400`

Extend `test/unit/client/lib/api.test.ts` with a new `resolveSessions()` helper test:

```typescript
await resolveSessions([
  { provider: 'codex', sessionId: '019cbc9d-bea0-7c93-9248-21d7e48f8ead' },
])

expect(mockFetch).toHaveBeenCalledWith(
  '/api/sessions/resolve',
  expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({
      sessions: [{ provider: 'codex', sessionId: '019cbc9d-bea0-7c93-9248-21d7e48f8ead' }],
    }),
  }),
)
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/api.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router.resolve.test.ts
```

Expected: FAIL because the exact lookup route and client helper do not exist yet.

**Step 3: Implement the lookup-only route and client helper**

In `server/sessions-router.ts`, add a lookup-only route. Keep the request explicit and capped:

```typescript
const ResolveSessionsBodySchema = z.object({
  sessions: z.array(z.object({
    provider: CodingCliProviderSchema,
    sessionId: z.string().min(1),
  })).min(1).max(100),
})

router.post('/sessions/resolve', (req, res) => {
  const parsed = ResolveSessionsBodySchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
  }

  const requested = new Set(parsed.data.sessions.map((session) => makeSessionKey(session.provider, session.sessionId)))
  const projects = codingCliIndexer.getProjects()
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => {
        const provider = session.provider || 'claude'
        return requested.has(makeSessionKey(provider, session.sessionId))
      }),
    }))
    .filter((project) => project.sessions.length > 0)

  res.json(projects)
})
```

In `src/lib/api.ts`, add:

```typescript
export async function resolveSessions(
  sessions: Array<{ provider: CodingCliProviderName; sessionId: string }>,
): Promise<ProjectGroup[]> {
  return api.post<ProjectGroup[]>('/api/sessions/resolve', { sessions })
}
```

Do not change `GET /api/sessions`, do not add pagination metadata here, and do not touch websocket protocol files in this task.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/api.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router.resolve.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/sessions-router.ts src/lib/api.ts test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: add exact session resolve lookup"
```

### Task 3: Merge Hydrated Sessions Into Canonical Session State

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Write the failing reducer tests**

Add tests for a new `mergeResolvedProjects()` reducer covering:
- upserting resolved sessions into an existing project without dropping the first-page recent sessions already loaded
- creating a new project when the resolved session belongs to a project not yet in state
- preserving project color
- not mutating `lastLoadedAt`, `wsSnapshotReceived`, `hasMore`, `loadingMore`, or the oldest-loaded cursor fields
- keeping the hydrated open-tab session after a later paginated `mergeSnapshotProjects()` baseline for the same project

Use an explicit action sequence for the last point:

```typescript
let state = sessionsReducer(undefined, setProjects(firstPage))
state = sessionsReducer(state, mergeResolvedProjects(openTabProject))
state = sessionsReducer(state, mergeSnapshotProjects(refreshedFirstPage))

expect(state.projects.find((p) => p.projectPath === '/repo')?.sessions.map((s) => s.sessionId)).toContain('open-tab-old')
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because `mergeResolvedProjects()` does not exist yet.

**Step 3: Implement the local merge reducer**

In `src/store/sessionsSlice.ts`, add a reducer that upserts individual sessions by `provider:sessionId` instead of replacing whole projects:

```typescript
mergeResolvedProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
  const incoming = normalizeProjects(action.payload)
  const projectMap = new Map(state.projects.map((project) => [
    project.projectPath,
    { ...project, sessions: [...project.sessions] },
  ]))

  for (const incomingProject of incoming) {
    const existing = projectMap.get(incomingProject.projectPath)
    if (!existing) {
      projectMap.set(incomingProject.projectPath, incomingProject)
      continue
    }

    const byKey = new Map(existing.sessions.map((session: any) => [
      `${session.provider || 'claude'}:${session.sessionId}`,
      session,
    ]))
    for (const session of incomingProject.sessions as any[]) {
      byKey.set(`${session.provider || 'claude'}:${session.sessionId}`, session)
    }

    projectMap.set(incomingProject.projectPath, {
      ...existing,
      ...incomingProject,
      sessions: Array.from(byKey.values()).sort(compareSessionsDesc),
    })
  }

  state.projects = sortProjectsByRecency(Array.from(projectMap.values()))
  // Intentionally do not touch lastLoadedAt, wsSnapshotReceived, or pagination meta.
}
```

Add a local `compareSessionsDesc()` inside this slice so merged project session arrays stay in descending recency order.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/sessionsSlice.ts test/unit/client/store/sessionsSlice.test.ts
git commit -m "feat: merge hydrated sessions into sidebar state"
```

### Task 4: Hydrate Missing Open-Tab Sessions After The First Server Baseline

**Files:**
- Modify: `src/App.tsx`
- Create: `test/unit/client/components/App.open-tab-session-hydration.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing App tests**

Create `test/unit/client/components/App.open-tab-session-hydration.test.tsx` and cover:
- App does not call `/api/sessions/resolve` before `wsSnapshotReceived === true`
- once the first authoritative baseline is ready, App resolves the missing local open-tab session and dispatches it into `sessions.projects`
- a foreign copied-tab locator (`sessionRef.serverInstanceId !== local server`) is ignored
- an empty or failed resolve result is parked for the current `lastLoadedAt` token so the effect does not tight-loop and spam requests
- when a later authoritative server update changes `lastLoadedAt`, the parked key retries

Extend `test/unit/client/components/App.ws-bootstrap.test.tsx` with the pre-connected fallback case:
- the initial `/api/sessions?limit=100` load fails
- the pre-connected fallback refetch succeeds and marks the baseline ready
- the hydration effect runs after that fallback baseline and resolves the missing open-tab session

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.open-tab-session-hydration.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: FAIL because `App` does not yet perform any missing-session hydration.

**Step 3: Implement the hydration orchestration in `App.tsx`**

Add a small orchestration effect in `App.tsx`:
- use `makeSelectKnownSessionKeys()` to get the canonical session key set
- use `collectSessionLocatorsFromTabs()` to gather open-tab locators
- gate on `wsSnapshotReceived` plus a numeric `lastLoadedAt`
- keep `attemptedAtByKeyRef` and `inFlightKeysRef` in component refs so request bookkeeping does not enter Redux
- batch resolve requests to the same `100`-item cap the route enforces
- dispatch `mergeResolvedProjects()` with the exact matches

Use the current server-driven timestamp as the retry token:

```typescript
const attemptedAtByKeyRef = useRef(new Map<string, number>())
const inFlightKeysRef = useRef(new Set<string>())

useEffect(() => {
  if (!wsSnapshotReceived || typeof lastLoadedAt !== 'number') return

  const hydratable = openSessionLocators.filter((locator) => {
    const key = `${locator.provider}:${locator.sessionId}`
    const sameServer = !locator.serverInstanceId || (
      localServerInstanceId != null && locator.serverInstanceId === localServerInstanceId
    )
    if (!sameServer) return false
    if (knownSessionKeys.has(key)) return false
    if (inFlightKeysRef.current.has(key)) return false
    return attemptedAtByKeyRef.current.get(key) !== lastLoadedAt
  })

  if (hydratable.length === 0) return

  void hydrateMissingOpenSessions(hydratable, lastLoadedAt)
}, [dispatch, knownSessionKeys, lastLoadedAt, localServerInstanceId, openSessionLocators, wsSnapshotReceived])
```

Important implementation details:
- prune the ref maps down to currently-open session keys each time the effect runs so they do not grow forever
- mark every key in a batch as attempted before firing the request so React re-renders cannot double-queue it
- keep `mergeResolvedProjects()` local-only: it must not modify `lastLoadedAt`, or the effect will immediately re-arm failed keys
- log resolve failures with the existing `App` logger, but leave the keys parked until the next authoritative server update changes `lastLoadedAt`

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/components/App.open-tab-session-hydration.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/App.tsx test/unit/client/components/App.open-tab-session-hydration.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: hydrate open-tab sessions into the sidebar"
```

### Task 5: Add A User-Visible Regression Test And Run Full Verification

**Files:**
- Create: `test/e2e/app-open-tab-sidebar-hydration.test.tsx`

**Step 1: Write the failing e2e regression**

Create an App-level regression that exercises the user-visible flow:
- seed the store with a tab and pane whose `sessionRef` or `resumeSessionId` points at an older session
- make `/api/sessions?limit=100` return only the newer first-page sessions
- make `/api/sessions/resolve` return the older open-tab session
- use a lightweight mocked `Sidebar` component that reads `state.sessions.projects` and renders the visible session titles from Redux
- assert that the older open-tab session title appears without any manual scroll or search

Sketch:

```typescript
await waitFor(() => {
  expect(screen.getByText('Older open tab session')).toBeInTheDocument()
})

expect(mockApiPost).toHaveBeenCalledWith(
  '/api/sessions/resolve',
  expect.objectContaining({
    sessions: [{ provider: 'codex', sessionId: 'open-tab-old' }],
  }),
)
```

**Step 2: Run the targeted e2e test to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/app-open-tab-sidebar-hydration.test.tsx
```

Expected: FAIL because the current App bootstrap never hydrates the missing open-tab session.

**Step 3: Finish any missing wiring in the test harness**

If the test needs extra harness wiring, keep it inside the test file:
- expose the session titles from the mocked `Sidebar`
- mock `api.post('/api/sessions/resolve')`
- drive the websocket into the same “baseline ready” state the real App uses

Do not add product code in this task unless the new e2e test reveals a real regression missed by the unit tests.

**Step 4: Run the e2e test, lint, and the full test suite**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/app-open-tab-sidebar-hydration.test.tsx
npm run lint
npm test
```

Expected: PASS for all three commands. If `npm test` surfaces any failure, stop and fix it before merging anything back to `main`.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/app-open-tab-sidebar-hydration.test.tsx
git commit -m "test: cover open-tab sidebar session hydration"
```
