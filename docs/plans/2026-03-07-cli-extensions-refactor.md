# CLI Extensions Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Create an `extensions/` folder in the repo where dropping a folder with a `freshell.json` manifest adds a new CLI pane type, and refactor Claude Code and Codex CLI to be the first two extensions using this system.

**Architecture:** The extension system infrastructure (ExtensionManager, manifests, routes, ExtensionPane) already exists. CLI extensions currently use a parallel hardcoded system: `TerminalMode` enum in spawn-spec.ts, `CodingCliProviderSchema` in ws-protocol.ts, `CODING_CLI_PROVIDER_CONFIGS` in coding-cli-utils.ts, `CLI_COMMANDS` in platform.ts, `CODING_CLI_COMMANDS` in spawn-spec.ts. This refactoring creates `extensions/claude-code/` and `extensions/codex-cli/` folders with `freshell.json` manifests, then rewires the server to derive CLI availability, spawn commands, picker visibility, and terminal modes from the extension registry instead of hardcoded lists. The frontend PanePicker already renders extension entries; CLI extensions need to create terminal panes (kind: 'terminal') rather than extension panes (kind: 'extension'), which requires a small routing change.

**Tech Stack:** TypeScript, Zod (manifest validation), Node.js (server), React/Redux (client), Vitest (testing)

**Testing strategy:** No unit tests only. Full E2E validation through the live UI on port :5173 -- open Chrome, create Claude and Codex panes, exchange messages, close and reopen them, and verify the full UX works correctly.

---

## Analysis: What Changes and What Stays

### Current hardcoded CLI registrations (to be replaced)

1. **`server/platform.ts` - `CLI_COMMANDS` array** -- detects which CLIs are available on the system (e.g., `which claude`). This feeds `availableClis` to the frontend.

2. **`server/spawn-spec.ts` - `TerminalMode` type + `CODING_CLI_COMMANDS` record** -- maps mode names to spawn commands, env vars, resume args, and labels. Used by `buildSpawnSpec()` to construct the PTY spawn arguments.

3. **`shared/ws-protocol.ts` - `CodingCliProviderSchema`** -- Zod enum `['claude', 'codex', 'opencode', 'gemini', 'kimi']` used in `TerminalCreateSchema.mode` field. This is the WS protocol contract.

4. **`src/lib/coding-cli-utils.ts` - `CODING_CLI_PROVIDER_CONFIGS`** -- frontend config for picker display, model/sandbox/permission support flags.

5. **`src/lib/coding-cli-types.ts`** -- re-exports `CodingCliProviderName` from ws-protocol.

### What stays unchanged (session indexing, providers)

The `server/coding-cli/` directory (session-indexer.ts, session-manager.ts, providers/claude.ts, providers/codex.ts, types.ts, utils.ts) handles session file parsing, JSONL indexing, and streaming JSON output. This is **orthogonal** to the extension system -- it's about understanding session history, not about spawning or picking CLI panes. These files stay as-is.

### The refactoring approach

Rather than trying to make the `TerminalMode` type dynamic (which would require changing the Zod schema, WS protocol, and dozens of type assertions), we take a pragmatic approach:

1. **Create extension manifest files** in `extensions/claude-code/` and `extensions/codex-cli/` with all the metadata needed.
2. **Add a third scan directory** for the repo-local `extensions/` folder (alongside `~/.freshell/extensions/` and `.freshell/extensions/`).
3. **Derive `availableClis`** from CLI extension manifests instead of the hardcoded `CLI_COMMANDS` array.
4. **Derive spawn commands** from CLI extension manifests instead of `CODING_CLI_COMMANDS`.
5. **Keep the `TerminalMode` type and WS protocol unchanged** -- CLI extensions register their `name` as a valid terminal mode. The Zod schema continues to validate known modes; unknown CLI extension modes pass through validation as the schema evolves.

### Key insight: CLI extensions create terminal panes, not extension panes

When the user selects a CLI extension from the picker, it should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`, NOT an `ExtensionPaneContent` (kind: 'extension'). CLI extensions use the existing terminal infrastructure (xterm.js, PTY, scrollback buffer). This is already how Claude/Codex work -- they're terminal panes with `mode: 'claude'` or `mode: 'codex'`.

---

### Task 1: Create extension manifest files for Claude Code and Codex CLI

**Files:**
- Create: `extensions/claude-code/freshell.json`
- Create: `extensions/claude-code/icon.svg`
- Create: `extensions/codex-cli/freshell.json`
- Create: `extensions/codex-cli/icon.svg`

**Step 1: Create Claude Code extension manifest**

Create `extensions/claude-code/freshell.json`:
```json
{
  "name": "claude",
  "version": "1.0.0",
  "label": "Claude Code",
  "description": "Anthropic's Claude Code CLI agent",
  "category": "cli",
  "icon": "./icon.svg",
  "cli": {
    "command": "claude",
    "args": [],
    "env": {
      "CLAUDE_CMD": "claude"
    }
  },
  "picker": {
    "shortcut": "L",
    "group": "agents"
  }
}
```

Create `extensions/claude-code/icon.svg` with the Claude icon (the existing provider icon SVG).

**Step 2: Create Codex CLI extension manifest**

Create `extensions/codex-cli/freshell.json`:
```json
{
  "name": "codex",
  "version": "1.0.0",
  "label": "Codex CLI",
  "description": "OpenAI's Codex CLI agent",
  "category": "cli",
  "icon": "./icon.svg",
  "cli": {
    "command": "codex",
    "args": [],
    "env": {
      "CODEX_CMD": "codex"
    }
  },
  "picker": {
    "shortcut": "X",
    "group": "agents"
  }
}
```

Create `extensions/codex-cli/icon.svg` with the Codex icon.

**Step 3: Verify manifests are valid**

Run the existing extension manifest validation in a quick test:
```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
const fs = require('fs');
const { ExtensionManifestSchema } = require('./server/extension-manifest.js');
for (const dir of ['extensions/claude-code', 'extensions/codex-cli']) {
  const raw = JSON.parse(fs.readFileSync(dir + '/freshell.json', 'utf-8'));
  const result = ExtensionManifestSchema.safeParse(raw);
  console.log(dir, result.success ? 'VALID' : result.error.format());
}
"
```

**Step 4: Commit**

```bash
git add extensions/
git commit -m "feat: add CLI extension manifests for Claude Code and Codex CLI"
```

---

### Task 2: Add repo-local extensions directory to scan path

**Files:**
- Modify: `server/index.ts` (lines ~146-148)

**Step 1: Add the repo extensions directory as a scan source**

In `server/index.ts`, the extension scan currently uses two directories:
```typescript
const userExtDir = path.join(os.homedir(), '.freshell', 'extensions')
const localExtDir = path.join(process.cwd(), '.freshell', 'extensions')
extensionManager.scan([userExtDir, localExtDir])
```

Add the repo `extensions/` directory as a third source, scanned first (lowest priority -- user overrides win):
```typescript
const userExtDir = path.join(os.homedir(), '.freshell', 'extensions')
const localExtDir = path.join(process.cwd(), '.freshell', 'extensions')
const builtinExtDir = path.join(process.cwd(), 'extensions')
extensionManager.scan([userExtDir, localExtDir, builtinExtDir])
```

**Step 2: Verify scan picks up the new extensions**

Start a dev server and check logs for "Extension scan complete" with claude and codex in the names list. Or run:
```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import { ExtensionManager } from './server/extension-manager.js';
const mgr = new ExtensionManager();
mgr.scan(['./extensions']);
console.log('Found:', mgr.getAll().map(e => e.manifest.name));
"
```

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: scan repo extensions/ directory for built-in CLI extensions"
```

---

### Task 3: Derive CLI availability from extension registry

Currently, `server/platform.ts` has a hardcoded `CLI_COMMANDS` array. After this task, CLI availability detection will also check registered CLI extensions from the ExtensionManager.

**Files:**
- Modify: `server/platform.ts` - `detectAvailableClis()` function
- Modify: `server/index.ts` - pass ExtensionManager to platform detection

**Step 1: Export the ExtensionManager reference for platform detection**

In `server/index.ts`, the `detectAvailableClis` function is passed to the platform router as a dependency. We need to pass the extension manager so it can check CLI extensions too.

Modify the `detectAvailableClis` call site in `server/index.ts` to pass the extension manager. The simplest approach: make `detectAvailableClis` accept an optional list of additional CLI names/commands from extensions.

In `server/platform.ts`, modify `detectAvailableClis` to accept an optional parameter:

```typescript
export async function detectAvailableClis(
  extraClis?: Array<{ name: string; command: string }>
): Promise<AvailableClis> {
  const allClis = [
    ...CLI_COMMANDS,
    ...(extraClis ?? []).map(c => ({ name: c.name, envVar: '', defaultCmd: c.command })),
  ]
  // Deduplicate by name (hardcoded wins for existing entries)
  const seen = new Set<string>()
  const dedupedClis = allClis.filter(cli => {
    if (seen.has(cli.name)) return false
    seen.add(cli.name)
    return true
  })
  const results = await Promise.all(
    dedupedClis.map(async (cli) => {
      const cmd = cli.envVar ? (process.env[cli.envVar] || cli.defaultCmd) : cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )
  return Object.fromEntries(results)
}
```

In `server/index.ts`, where `detectAvailableClis` is called (in the platform router deps), pass extra CLIs from extensions:

```typescript
const cliExtensions = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => ({ name: e.manifest.name, command: e.manifest.cli!.command }))

// In the platform router deps:
detectAvailableClis: () => detectAvailableClis(cliExtensions),
```

**Step 2: Commit**

```bash
git add server/platform.ts server/index.ts
git commit -m "feat: derive CLI availability from extension registry"
```

---

### Task 4: Derive spawn commands from CLI extension manifests

Currently, `server/spawn-spec.ts` has a hardcoded `CODING_CLI_COMMANDS` record that maps mode names to spawn specifications. We need CLI extensions to also provide spawn specs.

**Files:**
- Modify: `server/spawn-spec.ts` - add extension-aware command resolution
- Modify: `server/index.ts` - wire ExtensionManager to spawn spec resolution

**Step 1: Add fallback to extension registry in spawn-spec.ts**

The `resolveCodingCliCommand` function currently only checks `CODING_CLI_COMMANDS`. Add a fallback that checks the extension registry for CLI extensions with matching names.

Add a module-level variable that can be set by the server entry point:

```typescript
// Module-level extension registry reference for spawn resolution
let extensionManagerRef: { get(name: string): { manifest: { cli?: { command: string; args?: string[]; env?: Record<string, string> } } } | undefined } | null = null

export function setSpawnSpecExtensionManager(mgr: typeof extensionManagerRef) {
  extensionManagerRef = mgr
}
```

Modify `resolveCodingCliCommand` to fall back to extension manifests:

```typescript
function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string, target: ProviderTarget = 'unix') {
  if (mode === 'shell') return null

  // Check hardcoded specs first
  const spec = CODING_CLI_COMMANDS[mode]
  if (spec) {
    const command = process.env[spec.envVar] || spec.defaultCommand
    const providerArgs = providerNotificationArgs(mode, target)
    let resumeArgs: string[] = []
    if (resumeSessionId && spec.resumeArgs) {
      resumeArgs = spec.resumeArgs(resumeSessionId)
    }
    return { command, args: [...providerArgs, ...resumeArgs], label: spec.label }
  }

  // Fall back to extension registry
  if (extensionManagerRef) {
    const ext = extensionManagerRef.get(mode)
    if (ext?.manifest.cli) {
      const cli = ext.manifest.cli
      const envVarName = `${mode.toUpperCase()}_CMD`
      const command = process.env[envVarName] || cli.command
      return { command, args: cli.args || [], label: mode }
    }
  }

  return null
}
```

In `server/index.ts`, wire the extension manager:

```typescript
import { setSpawnSpecExtensionManager } from './spawn-spec.js'
// After extensionManager.scan():
setSpawnSpecExtensionManager(extensionManager)
```

**Step 2: Commit**

```bash
git add server/spawn-spec.ts server/index.ts
git commit -m "feat: resolve spawn commands from CLI extension manifests"
```

---

### Task 5: Make TerminalCreateSchema accept dynamic CLI extension modes

Currently, `TerminalCreateSchema.mode` is a hardcoded Zod enum: `z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi'])`. New CLI extensions added via the extensions folder won't pass validation.

**Files:**
- Modify: `shared/ws-protocol.ts` - relax mode validation to accept any string

**Step 1: Change mode from enum to string with fallback**

The `mode` field in `TerminalCreateSchema` needs to accept any string (so new CLI extensions work) while defaulting to 'shell'. Change from:

```typescript
mode: z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi']).default('shell'),
```

To:

```typescript
mode: z.string().default('shell'),
```

This is safe because:
- The server already casts `m.mode as TerminalMode` and passes it to `buildSpawnSpec()` which handles unknown modes by falling back to the extension registry (after Task 4).
- The `CodingCliProviderSchema` enum stays unchanged for session indexing and other typed uses.

**Step 2: Update the `TerminalMode` type in spawn-spec.ts**

Change `TerminalMode` from a union of string literals to a string type:

```typescript
export type TerminalMode = 'shell' | string
```

This preserves the 'shell' sentinel while allowing any extension name.

**Step 3: Commit**

```bash
git add shared/ws-protocol.ts server/spawn-spec.ts
git commit -m "feat: accept dynamic CLI extension modes in terminal create protocol"
```

---

### Task 6: Wire CLI extensions into PanePicker selection flow

Currently, when a CLI extension (`ext:name`) is selected from the PanePicker, it creates an `ExtensionPaneContent` (kind: 'extension'). But CLI extensions should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` - route CLI extensions to terminal pane creation
- Modify: `src/components/panes/PanePicker.tsx` - mark CLI extensions for terminal routing

**Step 1: In PaneContainer.tsx, handle CLI extensions in createContentForType**

Before the generic `ext:` handler, add a check for CLI extensions:

```typescript
const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
  if (typeof type === 'string' && type.startsWith('ext:')) {
    const extensionName = type.slice(4)
    // Check if this is a CLI extension - if so, create a terminal pane
    const ext = extensionEntries.find(e => e.name === extensionName)
    if (ext?.category === 'cli') {
      return {
        kind: 'terminal' as const,
        mode: extensionName as TabMode,
        shell: 'system' as const,
        createRequestId: nanoid(),
        status: 'creating' as const,
        ...(cwd ? { initialCwd: cwd } : {}),
      }
    }
    return {
      kind: 'extension' as const,
      extensionName,
      props: {},
    }
  }
  // ... rest unchanged
}, [extensionEntries, settings])
```

Add `extensionEntries` to the component's data by reading from the Redux store:

```typescript
const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? [])
```

**Step 2: In PanePicker.tsx, route CLI extensions through the directory picker**

Currently, extension options are just listed at the end. CLI extensions need to go through the directory picker (just like hardcoded CLI options do). In `handleSelect`:

```typescript
const handleSelect = useCallback((type: PanePickerType) => {
  // ... existing agent-chat check ...
  // ... existing coding-cli check ...

  // CLI extensions also go through directory picker
  if (typeof type === 'string' && type.startsWith('ext:')) {
    const extensionName = type.slice(4)
    const ext = extensionEntries.find(e => e.name === extensionName)
    if (ext?.category === 'cli') {
      setStep({ step: 'directory', providerType: type })
      return
    }
  }

  const newContent = createContentForType(type)
  dispatch(updatePaneContent({ tabId, paneId, content: newContent }))
}, [createContentForType, dispatch, tabId, paneId, extensionEntries])
```

**Step 3: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx
git commit -m "feat: route CLI extensions through terminal pane creation with directory picker"
```

---

### Task 7: Update frontend type system for dynamic CLI modes

The frontend `TabMode` type is currently `'shell' | CodingCliProviderName` which is a fixed enum. For CLI extensions to work, we need `TabMode` to accept any string.

**Files:**
- Modify: `src/store/types.ts` - widen TabMode type
- Modify: `src/lib/coding-cli-utils.ts` - adjust `isCodingCliProviderName` to check extensions
- Modify: `src/lib/coding-cli-types.ts` - widen type if needed

**Step 1: Widen TabMode to accept any string**

In `src/store/types.ts`:
```typescript
// TabMode includes 'shell' for regular terminals, plus all coding CLI providers
// (both hardcoded and extension-provided)
export type TabMode = 'shell' | CodingCliProviderName | string
```

This is technically the same as `string` but the union documents the known values.

**Step 2: Update isCodingCliMode to check extension registry**

In `src/lib/coding-cli-utils.ts`, the `isCodingCliMode` function is used to determine if a mode represents a CLI agent. Update it to also recognize CLI extension names:

```typescript
export function isCodingCliMode(mode?: string): boolean {
  if (!mode || mode === 'shell') return false
  if (isCodingCliProviderName(mode)) return true
  // Dynamic CLI extensions will also be valid modes
  // The caller should check the extension registry if isCodingCliProviderName returns false
  return false
}
```

Actually, the better approach is to leave `isCodingCliProviderName` for the hardcoded ones and add a separate check in the components that need to distinguish CLI modes. The components already have access to the extension registry via Redux.

**Step 3: Commit**

```bash
git add src/store/types.ts src/lib/coding-cli-utils.ts
git commit -m "feat: widen TabMode to accept dynamic CLI extension modes"
```

---

### Task 8: Update title derivation and icon rendering for CLI extensions

When a CLI extension pane is created, the title and icon should come from the extension manifest, not the hardcoded `CODING_CLI_PROVIDER_LABELS`.

**Files:**
- Modify: `src/lib/derivePaneTitle.ts` - check extension registry for CLI modes
- Modify: `src/components/icons/provider-icons.tsx` or equivalent - render extension icons

**Step 1: Update derivePaneTitle**

In `src/lib/derivePaneTitle.ts`, the terminal case uses `getProviderLabel(content.mode)` for CLI modes. This already works for hardcoded providers. For extension-provided CLIs, the label comes from the extension registry. Since `derivePaneTitle` is a pure function without Redux access, the simplest approach is to pass extension entries as an optional parameter:

Actually, looking at the code more carefully, `getProviderLabel` in coding-cli-utils.ts already has a fallback: `return label || provider.toUpperCase()`. So for an extension named 'gemini' that isn't in `CODING_CLI_PROVIDER_LABELS`, it would show 'GEMINI'. This is acceptable for now. The extension manifest `label` field would be the ideal source, but it requires plumbing the extension registry through.

The better approach: add the extension label to `CODING_CLI_PROVIDER_LABELS` dynamically isn't practical since it's a static object. Instead, update `getProviderLabel` to accept an optional fallback:

```typescript
export function getProviderLabel(provider?: string, extensionLabel?: string): string {
  if (!provider) return 'CLI'
  const label = CODING_CLI_PROVIDER_LABELS[provider as CodingCliProviderName]
  if (label) return label
  if (extensionLabel) return extensionLabel
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}
```

The callers that have extension data can pass it. This is a minimal change.

**Step 2: Commit**

```bash
git add src/lib/derivePaneTitle.ts src/lib/coding-cli-utils.ts
git commit -m "feat: support extension-provided labels for CLI pane titles"
```

---

### Task 9: End-to-end smoke test via live UI

**Testing approach:** Since the user specified "No unit tests only. You should actually make sure this works", we validate through the live UI on port :5173.

**Step 1: Start the dev server in the worktree**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

**Step 2: Verify extension scan in logs**

```bash
grep "Extension scan" /tmp/freshell-3344.log
# Should show: Extension scan complete { count: 2+, names: ['claude', 'codex', ...] }
```

**Step 3: Verify API endpoint**

```bash
curl http://localhost:3344/api/extensions | jq '.[].name'
# Should include "claude" and "codex"
```

**Step 4: Open Chrome and test via the live UI**

Using browser automation or manual testing on port :5173:

1. Open pane picker (click +, or Ctrl+N)
2. Verify Claude and Codex appear in the picker
3. Click Claude -- verify directory picker appears
4. Select a directory -- verify terminal pane opens with Claude Code
5. Type a message and verify Claude responds
6. Close the tab
7. Reopen Claude from picker -- verify it works again
8. Repeat steps 3-7 for Codex
9. Open Claude and Codex side by side -- verify both work independently

**Step 5: Verify existing tests still pass**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 6: Clean up test server**

```bash
kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid
```

**Step 7: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: address issues found during E2E testing of CLI extensions"
```

---

### Task 10: Run full test suite and fix any regressions

**Step 1: Run all tests**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 2: Fix any failures**

The most likely failures will be:
- Tests that assert on the hardcoded `TerminalCreateSchema.mode` enum values
- Tests that check `availableClis` detection
- Tests that rely on `TerminalMode` being a specific string literal union

Fix each failure by updating the test expectations to match the new dynamic behavior.

**Step 3: Run typecheck**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsc --noEmit
```

Fix any type errors.

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: update tests for CLI extensions refactor"
```

---

## Key Design Decisions

1. **CLI extensions create terminal panes, not extension panes.** The `kind: 'terminal'` pane with xterm.js is the right renderer for CLI agents. Extension panes (kind: 'extension') use iframes, which is wrong for CLI tools.

2. **The WS protocol `mode` field becomes a string.** This is the minimal change that allows new CLI extensions without breaking the existing contract. Old clients sending `'claude'` or `'codex'` still work.

3. **Hardcoded CLI configs remain as defaults.** The `CODING_CLI_COMMANDS` in spawn-spec.ts and `CLI_COMMANDS` in platform.ts remain as fallbacks. Extension manifests override them if present. This means existing installations without the `extensions/` folder continue to work unchanged.

4. **Session indexing is orthogonal.** The `server/coding-cli/providers/` directory handles session file parsing (JSONL, etc.) and is not part of the extension system. A future task could make session indexers discoverable via extensions, but that's a much larger change.

5. **No manifest changes needed.** The existing `freshell.json` manifest schema already supports CLI extensions with the `category: "cli"` and `cli: { command, args, env }` fields.

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits
- The live server on main must never be broken
- Work in the worktree at `/home/user/code/freshell/.worktrees/extensions-system`
