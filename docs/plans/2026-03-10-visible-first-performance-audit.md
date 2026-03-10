# Visible-First Performance Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a repeatable visible-first performance audit that runs six production-mode Freshell scenarios in Chromium, captures exactly one `desktop_local` sample and one `mobile_restricted` sample per scenario, and writes one schema-validated JSON artifact at `artifacts/perf/visible-first-audit.json`.

**Architecture:** Land a dedicated audit pipeline under `test/e2e-browser/perf/` instead of stretching the normal Playwright runner into a perf harness. Reuse the existing isolated `TestServer`, capture browser-observed HTTP and WebSocket truth through Chromium CDP, add only the minimum runtime-gated app instrumentation needed to mark focused-surface readiness, parse existing server JSONL logs for server-side work, and merge everything into one strict artifact contract plus a small diff tool.

**Tech Stack:** TypeScript, Node.js, Playwright Chromium API, existing `test/e2e-browser/helpers/TestServer`, Zod, Vitest, pino JSONL logs, browser `PerformanceObserver`, Node `perf_hooks`.

---

## Strategy Gate

The accepted direction is correct, but the previous plan was not excellent enough to execute unchanged.

The main problems were:

1. It asked the audit to report "offscreen work before focused readiness" without defining how that classification works.
2. Several tasks were still large enough that the execution agent would have to make architecture decisions mid-flight.
3. The artifact contract was directionally right but not explicit enough about which fields are authoritative and which are derived.
4. The scenario drivers were not yet specific enough about what constitutes readiness for sidebar search and offscreen tab hydration.

The right problem is not "add perf tests." The right problem is "create one trustworthy, repeatable characterization artifact for the current transport so the later visible-first work can be judged mechanically." That produces these non-negotiable design decisions:

1. The canonical output is the JSON artifact, not a test report, trace, or screenshot set.
2. HTTP timings/bytes and WebSocket frame counts/bytes must come from Chromium CDP, not app-side guesses.
3. Focused-surface readiness must come from explicit app milestones because transport data alone cannot safely infer "ready enough for the user."
4. Server-side work must come from existing JSONL logs and existing perf logging, not a parallel ad hoc reporting channel.
5. Every measured sample must be cold and isolated: fresh `TestServer`, fresh browser context, cleared storage, unique origin state.
6. Because the accepted strategy is exactly one desktop sample and one mobile-restricted sample per scenario, the artifact must preserve raw values; it must not invent medians or percentiles for scenario/profile results.
7. Offscreen/pre-focused work must be computed from scenario-specific allowlists: each scenario declares which HTTP paths and WebSocket message types are required before focused readiness, and everything else observed before the readiness milestone is counted as offscreen work.

This plan lands the requested end state directly:

1. `npm run perf:audit:visible-first` writes exactly one JSON artifact at `artifacts/perf/visible-first-audit.json` by default.
2. The artifact always contains the six approved scenarios and the two approved profiles unless an explicit smoke-test filter is passed.
3. `npm run perf:audit:compare -- --base <old> --candidate <new>` compares two schema-valid artifacts later without changing the artifact contract.

## Codebase Findings

1. [test-server.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/helpers/test-server.ts) is the correct isolation seam, but it currently removes the temp HOME on stop and does not expose the log directory. The audit runner cannot parse server logs without extending it.
2. [test-harness.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/test-harness.ts) is already the right browser test seam because it exposes Redux state, WebSocket readiness, and terminal buffers in production builds behind `?e2e=1`.
3. [perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/perf-logger.ts) already captures browser perf events and terminal input-to-output latency, but it only writes to console today.
4. [client-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/client-logger.ts) intentionally filters perf-tagged entries before posting to `/api/logs/client`. That behavior is correct and this audit should not bypass it.
5. [request-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/request-logger.ts) and [server/perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/perf-logger.ts) already emit most server-side information the audit needs into structured JSONL logs.
6. [test/e2e-browser/vitest.config.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/vitest.config.ts) only includes `helpers/**/*.test.ts` today, so perf smoke coverage will not run until that config is widened intentionally.
7. [package.json](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/package.json) already contains the correct repo-standard commands to reuse during implementation and verification: `test:client:standard`, `test:e2e:helpers`, and `test`.

## Scenario Matrix

Keep the scenario IDs and profile IDs stable. They are part of the artifact contract.

### Profiles

1. `desktop_local`
   Chromium desktop viewport `1440x900`, no throttling.
2. `mobile_restricted`
   Playwright `devices['iPhone 14']`, CDP network emulation at `1.6 Mbps down / 750 kbps up / 150 ms RTT`, no CPU throttling.

### Scenarios

1. `auth-required-cold-boot`
   Focused-ready milestone: auth-required UI is visible.
   Allowed-before-ready HTTP: `/api/settings`
   Allowed-before-ready WebSocket types: none
2. `terminal-cold-boot`
   Focused-ready milestone: active terminal is visible and first meaningful output exists.
   Allowed-before-ready HTTP: `/api/settings`, `/api/terminals`
   Allowed-before-ready WebSocket types: `hello`, `ready`, `terminal.create`, `terminal.created`, `terminal.output`, `terminal.list`, `terminal.meta.list`
3. `agent-chat-cold-boot`
   Focused-ready milestone: recent chat content is visible for a long-history session.
   Allowed-before-ready HTTP: `/api/settings`, `/api/sessions`, `/api/sessions/*`
   Allowed-before-ready WebSocket types: `hello`, `ready`, `sdk.history`, `sessions.updated`, `sessions.patch`
4. `sidebar-search-large-corpus`
   Focused-ready milestone: search results for the typed query are visible.
   Allowed-before-ready HTTP: `/api/settings`, `/api/sessions`, `/api/sessions/search*`
   Allowed-before-ready WebSocket types: `hello`, `ready`, `sessions.updated`, `sessions.patch`
5. `terminal-reconnect-backlog`
   Focused-ready milestone: reconnect shows current terminal output and replay-tail metrics are captured.
   Allowed-before-ready HTTP: `/api/settings`, `/api/terminals`
   Allowed-before-ready WebSocket types: `hello`, `ready`, `terminal.create`, `terminal.created`, `terminal.output`, `terminal.attach`, `terminal.snapshot`, `terminal.meta.list`, `terminal.list`
6. `offscreen-tab-selection`
   Focused-ready milestone: selecting a background tab hydrates it on demand and its content is visible.
   Allowed-before-ready HTTP: `/api/settings`
   Allowed-before-ready WebSocket types: `hello`, `ready`

The allowlists above are deliberate. The later visible-first project cares about "work that happened before the user's focused surface was ready but did not need to happen yet." The audit should compute that mechanically, not by interpretation after the fact.

## Artifact Contract

Implement the artifact contract once and make every producer and consumer share it. Use Zod in `test/e2e-browser/perf/audit-contract.ts`.

Top-level required fields:

1. `schemaVersion: 1`
2. `generatedAt`
3. `git: { commit, branch, dirty }`
4. `build: { nodeVersion, browserVersion, command }`
5. `profiles: [{ id, label, viewport, network }]`
6. `scenarios: VisibleFirstScenarioAudit[]`

Each scenario object must contain:

1. `id`
2. `description`
3. `focusedReadyMilestone`
4. `samples` with exactly two entries, one for `desktop_local` and one for `mobile_restricted`
5. `summaryByProfile`

Each sample object must contain:

1. `profileId`
2. `status`
3. `startedAt`
4. `finishedAt`
5. `durationMs`
6. `browser`
7. `transport`
8. `server`
9. `derived`
10. `errors`

The authoritative timing boundary for derived metrics is `focusedReadyMilestone`. Derived metrics must include:

1. `focusedReadyMs`
2. `httpRequestsBeforeReady`
3. `httpBytesBeforeReady`
4. `wsFramesBeforeReady`
5. `wsBytesBeforeReady`
6. `offscreenHttpRequestsBeforeReady`
7. `offscreenHttpBytesBeforeReady`
8. `offscreenWsFramesBeforeReady`
9. `offscreenWsBytesBeforeReady`
10. `terminalInputToFirstOutputMs` when applicable
11. `wsReadyMs` when applicable

The audit fails only when the artifact becomes untrustworthy:

1. scenario/profile timeout or crash
2. missing required readiness milestone
3. missing browser transport capture
4. missing server log capture
5. final JSON fails schema validation

It does not fail on performance budgets yet.

## Task 1: Lock the Artifact IDs and Schema

**Files:**
- Create: `test/e2e-browser/perf/audit-contract.ts`
- Create: `test/unit/lib/visible-first-audit-contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILE_IDS, AUDIT_SCENARIO_IDS, VisibleFirstAuditSchema } from '@test/e2e-browser/perf/audit-contract'

describe('VisibleFirstAuditSchema', () => {
  it('accepts a full artifact with six scenarios and exactly two samples per scenario', () => {
    const artifact = buildAuditFixture()
    expect(AUDIT_PROFILE_IDS).toEqual(['desktop_local', 'mobile_restricted'])
    expect(AUDIT_SCENARIO_IDS).toHaveLength(6)
    expect(VisibleFirstAuditSchema.parse(artifact).scenarios).toHaveLength(6)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts
```

Expected: FAIL with a module-not-found error for `audit-contract.ts`.

**Step 3: Write the minimal implementation**

Create `test/e2e-browser/perf/audit-contract.ts` with:

1. `AUDIT_SCENARIO_IDS`
2. `AUDIT_PROFILE_IDS`
3. strict Zod schemas for the top-level artifact, scenario objects, and sample objects
4. exported TypeScript types inferred from the schema

Do not defer field naming choices to later tasks.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-contract.ts test/unit/lib/visible-first-audit-contract.test.ts
git commit -m "test: define visible-first audit artifact contract"
```

## Task 2: Define Derived Metric and Offscreen Classification Rules

**Files:**
- Create: `test/e2e-browser/perf/derive-visible-first-metrics.ts`
- Create: `test/unit/lib/visible-first-audit-derived-metrics.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { deriveVisibleFirstMetrics } from '@test/e2e-browser/perf/derive-visible-first-metrics'

describe('deriveVisibleFirstMetrics', () => {
  it('counts transport before readiness and separates offscreen work by scenario allowlist', () => {
    const result = deriveVisibleFirstMetrics(buildSampleFixture())
    expect(result.offscreenHttpRequestsBeforeReady).toBe(1)
    expect(result.offscreenWsFramesBeforeReady).toBe(2)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: FAIL with a module-not-found error for `derive-visible-first-metrics.ts`.

**Step 3: Write the minimal implementation**

Create `derive-visible-first-metrics.ts` as a pure module that:

1. accepts one scenario definition plus one raw sample
2. uses the scenario's focused milestone timestamp as the readiness cutoff
3. treats any pre-ready HTTP path or WS type not in the scenario allowlist as offscreen work
4. returns only derived numeric data and no filesystem or Playwright state

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/derive-visible-first-metrics.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts
git commit -m "test: define visible-first derived metrics"
```

## Task 3: Keep Aggregation Pure and Deterministic

**Files:**
- Create: `test/e2e-browser/perf/audit-aggregator.ts`
- Create: `test/unit/lib/visible-first-audit-aggregator.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'

describe('summarizeScenarioSamples', () => {
  it('produces stable summaryByProfile entries without inventing medians', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local.focusedReadyMs).toBeTypeOf('number')
    expect(summary.mobile_restricted.offscreenWsBytesBeforeReady).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: FAIL with a module-not-found error for `audit-aggregator.ts`.

**Step 3: Write the minimal implementation**

Create `audit-aggregator.ts` as pure functions only. It should:

1. summarize one sample into compare-friendly fields
2. summarize one scenario into `desktop_local` and `mobile_restricted`
3. preserve profile ordering
4. never import Playwright, DOM, or filesystem code

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-aggregator.ts test/unit/lib/visible-first-audit-aggregator.test.ts
git commit -m "test: add visible-first audit aggregation"
```

## Task 4: Extend TestServer for Audit Retention

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the failing test**

```ts
it('exposes home and logs directories and can preserve them for audit collection', async () => {
  const server = new TestServer({
    preserveHomeOnStop: true,
    setupHome: async (homeDir) => {
      await fs.promises.mkdir(path.join(homeDir, '.claude', 'projects', 'perf'), { recursive: true })
    },
  })

  const info = await server.start()
  expect(info.homeDir).toContain('freshell-e2e-')
  expect(info.logsDir).toContain(path.join('.freshell', 'logs'))
  await server.stop()
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: FAIL because `preserveHomeOnStop`, `setupHome`, `homeDir`, and `logsDir` do not exist.

**Step 3: Write the minimal implementation**

Extend `TestServer` with:

1. `setupHome?: (homeDir: string) => Promise<void>`
2. `preserveHomeOnStop?: boolean`
3. `homeDir` and `logsDir` in `TestServerInfo`

Call `setupHome` after creating the temp HOME and before starting the server. Keep existing cleanup behavior unchanged for non-audit callers.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test: extend test server for perf audit retention"
```

## Task 5: Seed Deterministic Audit Fixture Data

**Files:**
- Create: `test/e2e-browser/perf/seed-home.ts`
- Create: `test/unit/lib/visible-first-audit-seed-home.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { seedVisibleFirstAuditHome } from '@test/e2e-browser/perf/seed-home'

describe('seedVisibleFirstAuditHome', () => {
  it('creates the large deterministic fixture set used by all six scenarios', async () => {
    const result = await seedVisibleFirstAuditHome(tmpHome)
    expect(result.sessionCount).toBeGreaterThan(100)
    expect(result.scenarioIds).toContain('offscreen-tab-selection')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: FAIL with a module-not-found error for `seed-home.ts`.

**Step 3: Write the minimal implementation**

Create `seed-home.ts` that deterministically writes:

1. a large session corpus for sidebar/search
2. a long agent-chat history fixture
3. persisted tab/pane state for offscreen-tab selection
4. reconnect/backlog fixture data for terminal replay scenarios

Reuse app-native file formats and persisted-state shapes instead of inventing synthetic formats.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/seed-home.ts test/unit/lib/visible-first-audit-seed-home.test.ts
git commit -m "test: add deterministic visible-first audit fixtures"
```

## Task 6: Create the Browser Audit Bridge

**Files:**
- Create: `src/lib/perf-audit-bridge.ts`
- Create: `test/unit/client/lib/perf-audit-bridge.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createPerfAuditBridge } from '@/lib/perf-audit-bridge'

describe('createPerfAuditBridge', () => {
  it('records milestones and returns serializable snapshots', () => {
    const audit = createPerfAuditBridge()
    audit.mark('app.bootstrap_ready', { view: 'terminal' })
    expect(audit.snapshot().milestones['app.bootstrap_ready']).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: FAIL because the audit bridge does not exist.

**Step 3: Write the minimal implementation**

Create `src/lib/perf-audit-bridge.ts` as an in-memory collector with:

1. milestone recording
2. metadata recording
3. client perf event collection
4. terminal latency sample collection
5. `snapshot()` returning serializable data only

Do not couple it to `window` directly.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-audit-bridge.ts test/unit/client/lib/perf-audit-bridge.test.ts
git commit -m "test: add browser perf audit bridge"
```

## Task 7: Feed Existing Client Perf Signals into the Bridge

**Files:**
- Modify: `src/lib/perf-logger.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing test**

```ts
it('forwards perf entries to an installed audit sink without changing console behavior', () => {
  const seen: unknown[] = []
  installClientPerfAuditSink((entry) => seen.push(entry))
  logClientPerf('perf.paint', { name: 'first-contentful-paint' })
  expect(seen).toHaveLength(1)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL because the audit sink API does not exist.

**Step 3: Write the minimal implementation**

Add a narrow sink API to `src/lib/perf-logger.ts`:

1. `installClientPerfAuditSink`
2. forwarding from `logClientPerf`
3. forwarding from `markTerminalOutputSeen`

Keep console logging unchanged and do not route perf entries through `/api/logs/client`.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-logger.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test: route client perf signals into audit sink"
```

## Task 8: Expose Audit Snapshots Through the Existing Test Harness

**Files:**
- Modify: `src/lib/test-harness.ts`
- Modify: `test/e2e-browser/helpers/test-harness.ts`
- Create: `test/unit/client/lib/test-harness.perf-audit.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'

describe('test harness perf audit helpers', () => {
  it('exposes a perf audit snapshot when installed', async () => {
    const harness = installHarnessForTest()
    expect(harness.getPerfAuditSnapshot().milestones).toBeDefined()
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/test-harness.perf-audit.test.ts
```

Expected: FAIL because the test harness does not expose audit snapshots.

**Step 3: Write the minimal implementation**

Extend both harness layers with:

1. `getPerfAuditSnapshot()`
2. `waitForAuditMilestone(name, timeoutMs?)` in the Playwright helper

Do not create a second browser-only bridge API when the existing harness can carry this.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/test-harness.perf-audit.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/test-harness.ts test/e2e-browser/helpers/test-harness.ts test/unit/client/lib/test-harness.perf-audit.test.ts
git commit -m "test: expose perf audit snapshots in harness"
```

## Task 9: Mark App Bootstrap and Auth-Required Milestones

**Files:**
- Modify: `src/App.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks auth-required readiness when booting without a token in perf audit mode', async () => {
  renderAppAt('/?e2e=1&perfAudit=1')
  expect(await getAuditMilestone('app.auth_required_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx
```

Expected: FAIL because the audit milestones are not emitted.

**Step 3: Write the minimal implementation**

In `src/App.tsx`, when `?e2e=1&perfAudit=1` is present:

1. install the bridge
2. mark `app.bootstrap_started`
3. mark `app.bootstrap_ready`
4. mark `app.ws_ready` when the socket becomes ready
5. mark `app.auth_required_visible` when the auth-required path wins

Keep audit behavior behind the runtime flag.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.lazy-views.test.tsx
git commit -m "test: add app bootstrap audit milestones"
```

## Task 10: Mark Terminal Readiness Milestones

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks terminal visibility and first output in perf audit mode', async () => {
  renderTerminalViewForAudit()
  expect(await getAuditMilestone('terminal.surface_visible')).toBeGreaterThanOrEqual(0)
  expect(await getAuditMilestone('terminal.first_output')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because the terminal milestones do not exist.

**Step 3: Write the minimal implementation**

In `TerminalView.tsx`:

1. mark `terminal.surface_visible` when the active terminal surface is mounted and visible
2. mark `terminal.first_output` on the first meaningful output for the active terminal

Do not emit milestones for inactive background terminals.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: add terminal audit milestones"
```

## Task 11: Mark Agent-Chat Readiness Milestones

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Create: `test/unit/client/components/AgentChatView.perf-audit.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks agent-chat surface visibility when recent messages render', async () => {
  renderAgentChatViewForAudit(longHistoryFixture)
  expect(await getAuditMilestone('agent_chat.surface_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/AgentChatView.perf-audit.test.tsx
```

Expected: FAIL because the agent-chat milestones do not exist.

**Step 3: Write the minimal implementation**

In `AgentChatView.tsx`:

1. mark `agent_chat.surface_visible` when the visible recent-message window is rendered
2. mark `agent_chat.restore_timed_out` if the existing timeout fallback path fires

Do not treat hidden history restoration as readiness.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/AgentChatView.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx
git commit -m "test: add agent chat audit milestones"
```

## Task 12: Mark Sidebar Search and Offscreen Tab Milestones

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabContent.tsx`
- Create: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Create: `test/unit/client/components/TabContent.perf-audit.test.tsx`

**Step 1: Write the failing tests**

```ts
it('marks sidebar search results visibility for the active query', async () => {
  renderSidebarForAudit()
  expect(await getAuditMilestone('sidebar.search_results_visible')).toBeGreaterThanOrEqual(0)
})
```

```ts
it('marks offscreen tab selection when the selected tab content becomes visible', async () => {
  renderTabContentForAudit()
  expect(await getAuditMilestone('tab.selected_surface_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: FAIL because those milestones do not exist.

**Step 3: Write the minimal implementation**

In `Sidebar.tsx`:

1. mark `sidebar.search_started` when the query is issued
2. mark `sidebar.search_results_visible` when visible results for the current query render

In `TabContent.tsx`:

1. mark `tab.selected_surface_visible` when the newly selected background tab becomes the visible tab surface

These milestones are required so the audit can draw the readiness boundary for the two most transport-sensitive non-terminal scenarios.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/TabContent.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
git commit -m "test: add sidebar and tab-selection audit milestones"
```

## Task 13: Record HTTP and WebSocket Transport Through CDP

**Files:**
- Create: `test/e2e-browser/perf/cdp-network-recorder.ts`
- Create: `test/unit/lib/visible-first-audit-network-recorder.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '@test/e2e-browser/perf/cdp-network-recorder'

describe('NetworkRecorder', () => {
  it('groups websocket frames by direction and message type', () => {
    const recorder = new NetworkRecorder()
    recorder.onFrame('received', JSON.stringify({ type: 'sessions.updated' }))
    recorder.onFrame('sent', JSON.stringify({ type: 'hello' }))
    const summary = recorder.summarize()
    expect(summary.byType).toContainEqual(
      expect.objectContaining({ direction: 'received', type: 'sessions.updated', count: 1 }),
    )
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: FAIL because the recorder does not exist.

**Step 3: Write the minimal implementation**

Implement `cdp-network-recorder.ts` around Chromium CDP:

1. enable `Network`
2. join `responseReceived` and `loadingFinished` into HTTP samples
3. record WebSocket frames from `webSocketFrameSent` and `webSocketFrameReceived`
4. bucket frame types from JSON payload `type`, falling back to `unknown`
5. expose raw samples plus `byPath` and `byType` summaries

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/cdp-network-recorder.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
git commit -m "test: add cdp transport recorder for audit runs"
```

## Task 14: Parse Server JSONL Logs Into Audit Data

**Files:**
- Create: `test/e2e-browser/perf/server-log-parser.ts`
- Create: `test/unit/lib/visible-first-audit-server-log-parser.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseServerDebugLogs } from '@test/e2e-browser/perf/server-log-parser'

describe('parseServerDebugLogs', () => {
  it('extracts http_request and perf_system entries from server logs', async () => {
    const parsed = await parseServerDebugLogs([fixtureLogPath])
    expect(parsed.httpRequests).toHaveLength(1)
    expect(parsed.perfSystem[0]?.event).toBe('perf_system')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: FAIL because the parser does not exist.

**Step 3: Write the minimal implementation**

Create `server-log-parser.ts` that:

1. reads `server-debug*.jsonl` files from the sample log directory
2. extracts `http_request`
3. extracts `perf_system`
4. extracts server perf events and terminal stream perf events
5. counts malformed lines in diagnostics instead of crashing the whole sample

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/server-log-parser.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts
git commit -m "test: parse server perf logs for audit artifacts"
```

## Task 15: Freeze the Approved Profile Matrix

**Files:**
- Create: `test/e2e-browser/perf/profiles.ts`
- Create: `test/unit/lib/visible-first-audit-profiles.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILES } from '@test/e2e-browser/perf/profiles'

describe('AUDIT_PROFILES', () => {
  it('defines exactly the approved desktop and restricted mobile profiles', () => {
    expect(AUDIT_PROFILES.map((profile) => profile.id)).toEqual([
      'desktop_local',
      'mobile_restricted',
    ])
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts
```

Expected: FAIL because `profiles.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `profiles.ts` with immutable definitions for:

1. desktop viewport
2. mobile device emulation
3. restricted-bandwidth CDP settings

Keep all profile constants in one place so the runner and compare tool cannot drift.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/profiles.ts test/unit/lib/visible-first-audit-profiles.test.ts
git commit -m "test: define visible-first audit profiles"
```

## Task 16: Freeze the Scenario Matrix and Driver Contracts

**Files:**
- Create: `test/e2e-browser/perf/scenarios.ts`
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('AUDIT_SCENARIOS', () => {
  it('defines the approved six scenarios in stable order with readiness and allowlists', () => {
    expect(AUDIT_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
    expect(AUDIT_SCENARIOS[0]?.focusedReadyMilestone).toBeTypeOf('string')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: FAIL because `scenarios.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `scenarios.ts` as data plus small driver functions. Each scenario definition must include:

1. stable `id`
2. `focusedReadyMilestone`
3. allowed-before-ready HTTP paths
4. allowed-before-ready WebSocket types
5. setup/navigation behavior
6. one final `collect()` step that returns the browser audit snapshot

Do not let scenario files own browser launch, server launch, artifact writing, or log parsing.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/scenarios.ts test/unit/lib/visible-first-audit-scenarios.test.ts
git commit -m "test: define visible-first audit scenarios"
```

## Task 17: Build the Per-Sample Runner

**Files:**
- Create: `test/e2e-browser/perf/run-sample.ts`
- Create: `test/unit/lib/visible-first-audit-run-sample.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { runAuditSample } from '@test/e2e-browser/perf/run-sample'

describe('runAuditSample', () => {
  it('returns one schema-shaped sample with merged browser, network, server, and derived data', async () => {
    const sample = await runAuditSample(buildRunSampleFixture())
    expect(sample.profileId).toBe('desktop_local')
    expect(sample.transport.http.byPath).toBeDefined()
    expect(sample.derived.focusedReadyMs).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-run-sample.test.ts
```

Expected: FAIL because `run-sample.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `run-sample.ts` that owns one complete cold sample:

1. start `TestServer` with `PERF_LOGGING=true`, `setupHome`, and preserved HOME
2. launch Chromium
3. apply the selected profile
4. attach the CDP recorder
5. execute one scenario driver
6. collect the browser audit snapshot
7. parse server logs
8. derive visible-first metrics
9. return one sample object
10. clean up browser and server in `finally`

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-run-sample.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-sample.ts test/unit/lib/visible-first-audit-run-sample.test.ts
git commit -m "test: add visible-first audit sample runner"
```

## Task 18: Build the Full Audit Runner and CLI

**Files:**
- Create: `test/e2e-browser/perf/run-visible-first-audit.ts`
- Create: `test/e2e-browser/perf/audit-cli.ts`
- Create: `scripts/visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-cli.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseAuditArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseAuditArgs', () => {
  it('defaults output to artifacts/perf/visible-first-audit.json', () => {
    expect(parseAuditArgs([]).outputPath).toContain('artifacts/perf/visible-first-audit.json')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: FAIL because the CLI helpers do not exist.

**Step 3: Write the minimal implementation**

Create:

1. `run-visible-first-audit.ts` to loop serially across the fixed scenario/profile matrix
2. `audit-cli.ts` to parse output path plus optional reduced smoke filters
3. `scripts/visible-first-audit.ts` to invoke the runner and write the artifact

Update `package.json` with:

```json
"perf:audit:visible-first": "tsx scripts/visible-first-audit.ts"
```

The runner must:

1. ensure a perf-enabled build exists
2. validate the final artifact with `VisibleFirstAuditSchema`
3. create `artifacts/perf/` when needed
4. write exactly one JSON file per invocation

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-visible-first-audit.ts test/e2e-browser/perf/audit-cli.ts scripts/visible-first-audit.ts package.json test/unit/lib/visible-first-audit-cli.test.ts
git commit -m "feat: add visible-first audit runner"
```

## Task 19: Build the Artifact Compare Tool

**Files:**
- Create: `scripts/compare-visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-compare.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { compareVisibleFirstAudits } from '../../scripts/compare-visible-first-audit'

describe('compareVisibleFirstAudits', () => {
  it('diffs two schema-valid artifacts by scenario and profile', () => {
    const diff = compareVisibleFirstAudits(baseAuditFixture(), candidateAuditFixture())
    expect(diff.scenarios[0]?.id).toBe('terminal-cold-boot')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: FAIL because the compare tool does not exist.

**Step 3: Write the minimal implementation**

Create `compare-visible-first-audit.ts` that:

1. loads two schema-valid artifacts
2. compares them by scenario and profile
3. emits concise JSON deltas for the derived metrics that will matter to the later visible-first work

Update `package.json` with:

```json
"perf:audit:compare": "tsx scripts/compare-visible-first-audit.ts"
```

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/compare-visible-first-audit.ts package.json test/unit/lib/visible-first-audit-compare.test.ts
git commit -m "feat: add visible-first audit compare tool"
```

## Task 20: Add Artifact Hygiene, Smoke Coverage, and Operator Docs

**Files:**
- Modify: `.gitignore`
- Modify: `test/e2e-browser/vitest.config.ts`
- Create: `test/e2e-browser/perf/visible-first-audit.smoke.test.ts`
- Modify: `README.md`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runVisibleFirstAudit } from './run-visible-first-audit'
import { VisibleFirstAuditSchema } from './audit-contract'

describe('visible-first audit smoke', () => {
  it('writes a schema-valid artifact for a reduced run', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'visible-first-audit-'))
    const outputPath = path.join(outputDir, 'audit.json')

    await runVisibleFirstAudit({
      outputPath,
      scenarioIds: ['auth-required-cold-boot'],
      profileIds: ['desktop_local'],
    })

    const parsed = VisibleFirstAuditSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
    expect(parsed.scenarios).toHaveLength(1)
  })
})
```

**Step 2: Run the smoke test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: FAIL because the helper config does not include `perf/**/*.test.ts` yet or the runner is not yet smoke-test friendly.

**Step 3: Write the minimal implementation**

1. Widen `test/e2e-browser/vitest.config.ts` to include `perf/**/*.test.ts`.
2. Ignore `artifacts/perf/` in `.gitignore`.
3. Add the smoke test.
4. Document in `README.md`:
   - how to run the audit
   - default artifact path
   - how to diff two artifacts
   - why the mobile sample is bandwidth-restricted

**Step 4: Run the smoke test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .gitignore test/e2e-browser/vitest.config.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts README.md
git commit -m "test: smoke test visible-first audit pipeline"
```

## Final Verification and Baseline Capture

Run these in order after all tasks are complete.

**Step 1: Run the focused tests**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-seed-home.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-run-sample.test.ts test/unit/lib/visible-first-audit-cli.test.ts test/unit/lib/visible-first-audit-compare.test.ts test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts test/unit/client/lib/test-harness.perf-audit.test.ts test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 2: Run the repo-standard full suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 3: Run the full audit**

Run:

```bash
npm run perf:audit:visible-first
```

Expected: `artifacts/perf/visible-first-audit.json` is written successfully.

**Step 4: Verify the artifact shape**

Run:

```bash
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('artifacts/perf/visible-first-audit.json','utf8')); console.log(data.schemaVersion, data.scenarios.length)"
```

Expected output:

```text
1 6
```

**Step 5: Verify compare mode**

Run:

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-audit.json --candidate artifacts/perf/visible-first-audit.json
```

Expected: PASS with zero deltas or an equivalent empty diff.

## Notes for the Execution Agent

1. Keep scenario IDs, profile IDs, milestone names, and artifact field names stable. Longitudinal value depends on it.
2. Do not reuse browser contexts or server instances across measured samples.
3. Do not route perf collection through `/api/logs/client`.
4. Prefer browser-observed truth over app instrumentation whenever the browser can already answer the question.
5. Only add app instrumentation for readiness states that cannot be inferred safely from transport events alone.
6. Do not invent summary statistics that the accepted sampling plan does not support.
7. Leave generated artifacts uncommitted unless explicitly asked to version a baseline.
