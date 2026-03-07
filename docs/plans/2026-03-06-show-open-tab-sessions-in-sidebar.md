# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a tab is present in the left sidebar even when it falls outside the paginated 100-session window.

**Architecture:** Keep `state.sessions.projects` as the canonical sidebar data source and hydrate only local open-tab sessions into that state with exact server lookups. Preserve `sessionRef.serverInstanceId` when collecting open session locators, filter out foreign-machine tabs before hydration, and track unresolved local refs in Redux against a server-driven catalog revision so zero-result resolves do not repost until the session catalog actually changes.

**Tech Stack:** React 18, Redux Toolkit, Express, Zod, Vitest, Testing Library, supertest

**Worktree:** `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`

**Notes:**
- The mounted sessions router is `server/sessions-router.ts`. Do not patch `server/routes/sessions.ts`; it is not used by `server/index.ts`.
- Pagination semantics stay intact. The first page is still the newest 100 sessions; open-tab sessions are hydrated out-of-band and merged into canonical state.
- Do not use `lastLoadedAt` as the hydration retry gate. `mergeResolvedProjects()` is a local upsert and must not re-arm unresolved open-session requests by itself.
- No `docs/index.html` update is needed for this change because the UI layout does not change; only sidebar data hydration changes.

---

### Task 1: Extract Shared Open-Session Locator Collection

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`

**Step 1: Write the failing tests**

Add focused tests to `test/unit/client/lib/session-utils.test.ts` for a new helper that walks tabs + pane layouts and returns deduped session locators for all open sessions. Cover:

- terminal panes with `resumeSessionId`
- agent-chat panes (`provider: 'claude'`)
- tabs without layouts using the legacy tab-level fallback
- duplicate session refs across multiple panes/tabs
- invalid Claude IDs ignored the same way existing helpers already ignore them
- explicit `sessionRef.serverInstanceId` is preserved for copied cross-device tabs
- the ref-only wrapper drops `serverInstanceId` but keeps provider/sessionId ordering stable

Use concrete expectations like:

```typescript
expect(collectSessionLocatorsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'local-codex' },
  { provider: 'codex', sessionId: 'remote-codex', serverInstanceId: 'srv-remote' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])

expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'codex-session-1' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts
```

Expected: FAIL because `collectSessionLocatorsFromTabs` does not exist yet.

**Step 3: Implement the shared helpers and refactor sidebar tab detection**

In `src/lib/session-utils.ts`, add a locator-preserving helper and keep a thin ref-only wrapper for existing call sites:

```typescript
export function collectSessionLocatorsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: Pick<RootState['panes'], 'layouts'>,
): SessionLocator[] {
  const seen = new Set<string>()
  const locators: SessionLocator[] = []

  const push = (locator: SessionLocator) => {
    const provider = locator.provider
    const sessionId = locator.sessionId
    const key = `${provider}:${sessionId}`
    if (seen.has(key)) return
    seen.add(key)
    locators.push(locator)
  }

  // Prefer explicit sessionRef so copied tabs keep their source serverInstanceId.
  // Fall back to legacy resumeSessionId only when no explicit locator exists.
  // Keep the same Claude UUID validation rules as extractSessionRef().
}

export function collectSessionRefsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: Pick<RootState['panes'], 'layouts'>,
): Array<{ provider: CodingCliProviderName; sessionId: string }> {
  return collectSessionLocatorsFromTabs(tabs, panes).map(({ provider, sessionId }) => ({ provider, sessionId }))
}
```

Then refactor `src/store/selectors/sidebarSelectors.ts` so `buildSessionItems()` uses `collectSessionRefsFromTabs()` instead of keeping its own inline tab traversal logic. The sidebar `hasTab` behavior stays unchanged in this task; the new locator helper exists so Task 4 can apply local-only hydration rules.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts
git commit -m "refactor: share open-tab session locator collection"
```

---

### Task 2: Add Exact Session Resolve API For Open Tabs

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `src/lib/api.ts`
- Create: `test/unit/server/sessions-router.resolve.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing server and client API tests**

Create `test/unit/server/sessions-router.resolve.test.ts` with cases for:

- `POST /sessions/resolve` returns only requested sessions, grouped by project
- duplicate request entries are deduped
- missing sessions are ignored instead of failing the whole request
- malformed bodies return `400`

Add client tests to `test/unit/client/lib/api.test.ts` that verify a new helper POSTs JSON like:

```json
{
  "sessions": [
    { "provider": "codex", "sessionId": "019cbc9d-bea0-7c93-9248-21d7e48f8ead" }
  ]
}
```

to `/api/sessions/resolve`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
```

Expected: FAIL because the route/helper do not exist yet.

**Step 3: Implement the route and client helper**

In `server/sessions-router.ts`, add:

```typescript
const ResolveSessionsRequestSchema = z.object({
  sessions: z.array(z.object({
    provider: CodingCliProviderSchema,
    sessionId: z.string().min(1),
  })).min(1).max(200),
})

router.post('/sessions/resolve', async (req, res) => {
  const parsed = ResolveSessionsRequestSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
  }

  const wanted = new Set(
    parsed.data.sessions.map((session) => makeSessionKey(session.provider, session.sessionId)),
  )

  const projects = codingCliIndexer.getProjects()
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) =>
        wanted.has(makeSessionKey(session.provider, session.sessionId)),
      ),
    }))
    .filter((project) => project.sessions.length > 0)

  res.json({ projects })
})
```

In `src/lib/api.ts`, add a typed helper:

```typescript
export async function resolveSessions(
  sessions: Array<{ provider: CodingCliProviderName; sessionId: string }>,
): Promise<{ projects: ProjectGroup[] }> {
  return api.post('/api/sessions/resolve', { sessions })
}
```

If `ProjectGroup` import would create a runtime cycle, use `import type`.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/sessions-router.ts src/lib/api.ts test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: add exact session resolve API for open tabs"
```

---

### Task 3: Add Server-Catalog Revision And Durable Open-Tab Hydration State

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Write the failing reducer tests**

Add reducer tests covering two concerns:

1. `mergeResolvedProjects()` behavior:
- adding an older resolved session into an already-loaded project without dropping existing sessions
- adding a resolved session for a project not yet present in `state.projects`
- replacing a stale copy of an already-known session by `provider:sessionId`
- preserving provider collisions (`claude:s1` and `codex:s1` are different sessions)
- **not** incrementing the new server-catalog revision counter

2. Durable hydration state:
- `setProjects`, `mergeSnapshotProjects`, `appendSessionsPage`, and `applySessionsPatch` increment `serverCatalogRevision`
- `markOpenTabHydrationRequested()` marks keys as `inFlight`
- `settleOpenTabHydrationRequest()` clears resolved keys and marks zero-result keys as unresolved for the **current** `serverCatalogRevision`
- `clearOpenTabHydrationRequest()` clears failed in-flight markers without permanently suppressing retries
- `clearProjects()` resets both `serverCatalogRevision` and `openTabHydration`

Use concrete examples like:

```typescript
state = sessionsReducer(state, mergeResolvedProjects([
  {
    projectPath: '/project/a',
    sessions: [
      { provider: 'codex', sessionId: 'open-old', projectPath: '/project/a', updatedAt: 123, title: 'Open old session' },
    ],
  },
]))

state = sessionsReducer(state, markOpenTabHydrationRequested({
  sessionKeys: ['codex:missing-open'],
}))

state = sessionsReducer(state, settleOpenTabHydrationRequest({
  requestedKeys: ['codex:missing-open'],
  resolvedKeys: [],
}))

expect(state.openTabHydration['codex:missing-open']).toEqual({
  inFlight: false,
  unresolvedCatalogRevision: state.serverCatalogRevision,
})
```

**Step 2: Run the reducer tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because the new revision/hydration reducers do not exist yet.

**Step 3: Implement server-catalog revision tracking, durable hydration metadata, and `mergeResolvedProjects`**

Extend `SessionsState` with:

```typescript
serverCatalogRevision: number
openTabHydration: Record<string, {
  inFlight: boolean
  unresolvedCatalogRevision?: number
}>
```

Add small helpers inside `src/store/sessionsSlice.ts`:

```typescript
function knownSessionKeys(projects: ProjectGroup[]): Set<string> {
  const keys = new Set<string>()
  for (const project of projects) {
    for (const session of project.sessions) {
      keys.add(`${(session as any).provider || 'claude'}:${(session as any).sessionId}`)
    }
  }
  return keys
}

function bumpServerCatalogRevision(state: SessionsState): void {
  state.serverCatalogRevision += 1
}

function clearKnownHydrationEntries(state: SessionsState): void {
  const known = knownSessionKeys(state.projects)
  for (const key of Object.keys(state.openTabHydration)) {
    if (known.has(key)) delete state.openTabHydration[key]
  }
}
```

Then:

- increment `serverCatalogRevision` only in reducers driven by server snapshots/pages/patches (`setProjects`, `mergeSnapshotProjects`, `appendSessionsPage`, `applySessionsPatch`, `clearProjects`)
- keep `mergeResolvedProjects()` as a **local** partial upsert and do **not** increment `serverCatalogRevision`
- implement:

```typescript
markOpenTabHydrationRequested: (state, action: PayloadAction<{ sessionKeys: string[] }>) => {
  for (const key of action.payload.sessionKeys) {
    const current = state.openTabHydration[key]
    state.openTabHydration[key] = {
      inFlight: true,
      unresolvedCatalogRevision: current?.unresolvedCatalogRevision,
    }
  }
},

settleOpenTabHydrationRequest: (
  state,
  action: PayloadAction<{ requestedKeys: string[]; resolvedKeys: string[] }>,
) => {
  const resolved = new Set(action.payload.resolvedKeys)
  for (const key of action.payload.requestedKeys) {
    if (resolved.has(key)) {
      delete state.openTabHydration[key]
      continue
    }
    state.openTabHydration[key] = {
      inFlight: false,
      unresolvedCatalogRevision: state.serverCatalogRevision,
    }
  }
},

clearOpenTabHydrationRequest: (state, action: PayloadAction<{ sessionKeys: string[] }>) => {
  for (const key of action.payload.sessionKeys) {
    const current = state.openTabHydration[key]
    if (!current) continue
    if (current.unresolvedCatalogRevision === undefined) delete state.openTabHydration[key]
    else state.openTabHydration[key] = { ...current, inFlight: false }
  }
},
```

Keep `mergeResolvedProjects()` as the partial-upsert reducer from the original plan, but after it writes `state.projects`, call `clearKnownHydrationEntries(state)` so keys that were just resolved disappear from the suppression map.

**Step 4: Re-run the reducer tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS. In particular, `mergeResolvedProjects()` should not bump `serverCatalogRevision`, and a zero-result settle should park the key on the current revision.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/sessionsSlice.ts test/unit/client/store/sessionsSlice.test.ts
git commit -m "feat: track durable open-tab session hydration state"
```

---

### Task 4: Add Local-Only Hydration Selectors And App Orchestration

**Files:**
- Create: `src/store/selectors/openSessionSelectors.ts`
- Create: `test/unit/client/store/selectors/openSessionSelectors.test.ts`
- Modify: `src/App.tsx`
- Create: `test/unit/client/components/App.open-tab-session-hydration.test.tsx`

**Step 1: Write the failing selector and App tests**

Create `test/unit/client/store/selectors/openSessionSelectors.test.ts` covering:

- only open sessions missing from `state.sessions.projects` are returned
- explicit foreign locators (`sessionRef.serverInstanceId !== state.connection.serverInstanceId`) are excluded
- explicit locators wait when `sessionRef.serverInstanceId` exists but the local `serverInstanceId` is still unknown
- keys parked in `openTabHydration` for the current `serverCatalogRevision` are excluded
- a later `serverCatalogRevision` makes the same unresolved local key eligible again
- unrelated state changes return the same memoized array reference

Create `test/unit/client/components/App.open-tab-session-hydration.test.tsx` covering:

- bootstrap loads `/api/sessions?limit=100` without the open session
- App then calls `POST /api/sessions/resolve` exactly once for the missing open session
- App dispatches `mergeResolvedProjects()` and the store ends up containing that session
- a zero-result `/api/sessions/resolve` response marks the key unresolved and does **not** immediately repost on rerender or unrelated local state changes
- a delayed-index case: first resolve returns zero projects, then a later **server-driven** catalog update re-arms the same key and a second resolve merges it successfully
- a copied remote tab with `sessionRef.serverInstanceId = 'srv-remote'` and local `serverInstanceId = 'srv-local'` never calls `/api/sessions/resolve`

Mock heavy children (`TabContent`, `HistoryView`, etc.) but keep the real store and `App`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: FAIL because the selectors/effect and durable request state do not exist yet.

**Step 3: Implement the selectors and hydration effect**

Create `src/store/selectors/openSessionSelectors.ts` with stable memoized selectors built on the new locator helper:

```typescript
const selectProjects = (state: RootState) => state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes
const selectLocalServerInstanceId = (state: RootState) => state.connection.serverInstanceId
const selectServerCatalogRevision = (state: RootState) => state.sessions.serverCatalogRevision
const selectOpenTabHydration = (state: RootState) => state.sessions.openTabHydration

function toSessionKey(provider: CodingCliProviderName, sessionId: string): string {
  return `${provider}:${sessionId}`
}

export const selectHydratableOpenSessionLocators = createSelector(
  [selectProjects, selectTabs, selectPanes, selectLocalServerInstanceId, selectOpenTabHydration, selectServerCatalogRevision],
  (projects, tabs, panes, localServerInstanceId, openTabHydration, serverCatalogRevision) => {
    const known = new Set<string>()
    for (const project of projects) {
      for (const session of project.sessions) {
        known.add(toSessionKey(session.provider || 'claude', session.sessionId))
      }
    }

    return collectSessionLocatorsFromTabs(tabs, panes).filter((locator) => {
      const key = toSessionKey(locator.provider, locator.sessionId)
      if (known.has(key)) return false

      // Cross-device semantics: only hydrate refs that are definitely local.
      if (locator.serverInstanceId) {
        if (!localServerInstanceId) return false
        if (locator.serverInstanceId !== localServerInstanceId) return false
      }

      const hydration = openTabHydration[key]
      if (hydration?.inFlight) return false
      if (hydration?.unresolvedCatalogRevision === serverCatalogRevision) return false
      return true
    })
  },
)

export const selectHydratableOpenSessionRefs = createSelector(
  [selectHydratableOpenSessionLocators],
  (locators) => locators.map(({ provider, sessionId }) => ({ provider, sessionId })),
)
```

In `src/App.tsx`, replace the original `lastLoadedAt`-based idea with a request-state-driven effect:

```typescript
const hydratableOpenSessionRefs = useAppSelector(selectHydratableOpenSessionRefs)

useEffect(() => {
  if (hydratableOpenSessionRefs.length === 0) return

  const requestedKeys = hydratableOpenSessionRefs
    .map((ref) => `${ref.provider}:${ref.sessionId}`)
    .sort()

  dispatch(markOpenTabHydrationRequested({ sessionKeys: requestedKeys }))

  let cancelled = false
  void resolveSessions(hydratableOpenSessionRefs)
    .then((response) => {
      if (cancelled) return

      const projects = response.projects || []
      const resolvedKeys = projects.flatMap((project) =>
        (project.sessions || []).map((session: any) => `${session.provider || 'claude'}:${session.sessionId}`),
      )

      if (projects.length > 0) {
        dispatch(mergeResolvedProjects(projects))
      }
      dispatch(settleOpenTabHydrationRequest({ requestedKeys, resolvedKeys }))
    })
    .catch((err) => {
      if (cancelled) return
      log.warn('Failed to resolve open-tab sessions', err)
      dispatch(clearOpenTabHydrationRequest({ sessionKeys: requestedKeys }))
    })

  return () => { cancelled = true }
}, [dispatch, hydratableOpenSessionRefs])
```

Key guardrails:

- do not run for copied remote tabs whose explicit `sessionRef.serverInstanceId` points at another server
- do not guess that a locator with explicit `serverInstanceId` is local before `state.connection.serverInstanceId` is known
- do not dispatch placeholder sidebar rows before the canonical payload arrives
- a zero-result resolve must park the key on the current `serverCatalogRevision`
- only a later **server-driven** catalog update should make the unresolved key eligible again; `mergeResolvedProjects()` alone must not do that

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/selectors/openSessionSelectors.ts src/App.tsx test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
git commit -m "feat: hydrate only local open-tab sessions"
```

---

### Task 5: Add A User-Visible Sidebar Regression Test

**Files:**
- Create: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Write the failing end-to-end regression test**

Create focused UI flows in `test/e2e/open-tab-session-sidebar-visibility.test.tsx` that:

1. local-session case:
   - render `App` with a preloaded tab/pane resuming `codex:019cbc9d-bea0-7c93-9248-21d7e48f8ead`
   - mock `/api/sessions?limit=100` to return a page that does **not** include that session
   - mock `/api/sessions/resolve` to return the canonical session record with its real title/project
   - keep the real `Sidebar` mounted
   - assert the sidebar eventually shows the resolved session title and marks it as having a tab

2. remote-copy case:
   - render `App` with a preloaded copied pane whose `sessionRef.serverInstanceId` is `srv-remote`
   - set the local server instance to `srv-local`
   - assert `/api/sessions/resolve` is never called for that pane
   - assert the sidebar does not invent a local row for the foreign session

Target assertion shape:

```typescript
const button = await screen.findByRole('button', { name: /codex resume 019cbc9d/i })
expect(button).toHaveAttribute('data-has-tab', 'true')
expect(button).toHaveAttribute('data-provider', 'codex')
```

**Step 2: Run the new e2e test to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL before Task 4 is in place; PASS after Task 4.

**Step 3: Make the smallest production fix only if the e2e exposes a real gap**

Most likely no new production change is needed here. If the e2e still fails after Task 4, fix the actual issue it reveals instead of weakening the assertion.

**Step 4: Re-run the e2e and closely related sidebar flows**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: cover local and remote open-session sidebar hydration"
```

---

### Task 6: Full Verification And Final Cleanup

**Files:**
- No new files expected unless the full suite exposes follow-up fixes

**Step 1: Run the full focused regression set**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/server/sessions-router.resolve.test.ts \
  test/unit/client/lib/api.test.ts \
  test/unit/client/store/sessionsSlice.test.ts \
  test/unit/client/store/selectors/openSessionSelectors.test.ts \
  test/unit/client/components/App.open-tab-session-hydration.test.tsx \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx \
  test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 2: Run typecheck + tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm run check
```

Expected: PASS.

**Step 3: Run the full test suite required before merge**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm test
```

Expected: PASS.

**Step 4: Inspect the worktree and commit any suite-driven fixups**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git status --short
```

If the full suite required follow-up fixes, commit them with:

```bash
git add <exact files>
git commit -m "fix: finalize open-tab session sidebar hydration"
```

If `git status --short` is empty, do not create an empty commit.
