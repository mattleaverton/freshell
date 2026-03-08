# CLI Extensions Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Create an `extensions/` folder in the repo where dropping a folder with a `freshell.json` manifest adds a new CLI pane type. Refactor the existing hardcoded CLI registrations (Claude Code, Codex CLI, OpenCode, Gemini, Kimi) out of the source code and into extension manifests as the **single source of truth**.

**Architecture:** The extension system infrastructure (ExtensionManager, manifests, routes, ExtensionPane) already exists. CLI registrations are currently scattered across 5+ files as hardcoded lists: `CODING_CLI_COMMANDS` in `server/terminal-registry.ts`, `CLI_COMMANDS` in `server/platform.ts`, `CodingCliProviderSchema` in `shared/ws-protocol.ts` (and a duplicate in `server/ws-schemas.ts`), `CODING_CLI_PROVIDER_CONFIGS` in `src/lib/coding-cli-utils.ts`, and `CODING_CLI_PROVIDER_LABELS` ibid.

This refactoring creates extension folders (e.g., `extensions/claude-code/freshell.json`) for each CLI, then **removes** the hardcoded registrations and replaces them with dynamic derivation from the extension registry. After this refactoring:
- `CODING_CLI_COMMANDS` becomes a `Map<string, CodingCliCommandSpec>` built from extension manifests at startup
- `CLI_COMMANDS` in `platform.ts` is replaced by a function parameter from the extension registry
- `CodingCliProviderSchema` becomes a dynamic `z.string().refine()` instead of a hardcoded `z.enum()`
- `CODING_CLI_PROVIDER_CONFIGS` and `CODING_CLI_PROVIDER_LABELS` on the frontend are derived from the extension entries in Redux
- Adding a new CLI (e.g., OpenCode) means dropping a folder in `extensions/` -- zero code changes

The frontend PanePicker already renders extension entries; CLI extensions need to create terminal panes (kind: 'terminal') rather than extension panes (kind: 'extension'), which requires a small routing change.

**Tech Stack:** TypeScript, Zod (manifest validation), Node.js (server), React/Redux (client), Vitest (testing)

**Testing strategy:** No unit tests only. Full E2E validation through the live UI on port :5173 -- open Chrome, create Claude and Codex panes, exchange messages, close and reopen them, and verify the full UX works correctly.

---

## Analysis: What Changes and What Stays

### The central file: `server/terminal-registry.ts`

**`server/terminal-registry.ts`** is the authoritative location for PTY lifecycle management and spawn logic. It contains:

- `TerminalMode` type (line 33): `'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'`
- `CodingCliCommandSpec` type (line 36): includes `label`, `envVar`, `defaultCommand`, `resumeArgs`, and `supportsPermissionMode`
- `CODING_CLI_COMMANDS` record (line 44): `Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec>` -- maps mode names to spawn specs
- `resolveCodingCliCommand()` (line 205): accepts `mode`, `resumeSessionId`, `target`, and `providerSettings` params
- `buildSpawnSpec()` (line 622): constructs PTY spawn arguments from mode, cwd, shell, etc.
- `TerminalRegistry` class (line 792): manages PTY processes, constructed with `(settings?, maxTerminals?, maxExitedTerminals?)`
- `modeSupportsResume()` (line 79): checks if a mode has `resumeArgs`
- `getModeLabel()` (line 233): returns display label for a mode

**Note:** `server/spawn-spec.ts` exists but is dead code -- it is never imported by any production or test file. All references in this plan target `server/terminal-registry.ts`.

### Single source of truth: extension manifests replace hardcoded lists

The user explicitly said "In the refactoring, you'll move those there" -- meaning the hardcoded CLI registrations in source code must be **replaced** by extension manifests, not supplemented. After this refactoring:

1. **`CODING_CLI_COMMANDS`** in `server/terminal-registry.ts` changes from a hardcoded `Record` to a dynamic `Map<string, CodingCliCommandSpec>` built at server startup from the extension registry
2. **`CLI_COMMANDS`** in `server/platform.ts` is removed; `detectAvailableClis()` derives its CLI list from an argument populated by the extension registry
3. **`CodingCliProviderSchema`** in both `shared/ws-protocol.ts` and `server/ws-schemas.ts` changes from a hardcoded `z.enum()` to a dynamic `z.string().refine()` that validates against the set of registered CLI extension names
4. **`CODING_CLI_PROVIDER_CONFIGS`**, **`CODING_CLI_PROVIDER_LABELS`**, and **`CODING_CLI_PROVIDERS`** in `src/lib/coding-cli-utils.ts` are replaced by derivation from the Redux `extensions.entries` state

### Type strategy: `TerminalMode` becomes `'shell' | string`

Since `CODING_CLI_COMMANDS` will be a dynamic `Map<string, CodingCliCommandSpec>` (not a static `Record<Exclude<TerminalMode, 'shell'>, ...>`), there is no static record type to protect. `TerminalMode` widens to `'shell' | string`. No dual-type system (`TerminalModeOrExtension`) is needed.

On the frontend, `TabMode` (currently `'shell' | CodingCliProviderName`) also widens to `'shell' | string`. `CodingCliProviderName` becomes `string`.

### WS protocol validation: dynamic schemas

The `CodingCliProviderSchema` is used in four schemas that validate incoming WS messages:
- `TerminalCreateSchema.mode` (line 170 of `shared/ws-protocol.ts`)
- `CodingCliCreateSchema.provider` (line 252)
- `SessionLocatorSchema.provider` (line 41)
- `TerminalMetaRecordSchema.provider` (line 71)

All four must accept dynamically-registered CLI extension names. The solution is to export factory functions that accept the set of valid provider names, and build schemas with `z.string().refine()` instead of `z.enum()`.

The ws-handler already constructs its own `ClientMessageSchema` at module level (line 238 of ws-handler.ts); we move this construction to the `WsHandler` constructor, where the `extensionManager` is already available.

`server/ws-schemas.ts` has its own copies of `CodingCliProviderSchema`, `TerminalCreateSchema`, and `ClientMessageSchema`. These must also be made dynamic or replaced with imports from the shared module.

### Key insight: CLI extensions create terminal panes, not extension panes

When the user selects a CLI extension from the picker, it should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`, NOT an `ExtensionPaneContent` (kind: 'extension'). CLI extensions use the existing terminal infrastructure (xterm.js, PTY, scrollback buffer). This is already how Claude/Codex work -- they're terminal panes with `mode: 'claude'` or `mode: 'codex'`.

### What stays unchanged (session indexing, providers)

The `server/coding-cli/` directory (session-indexer.ts, session-manager.ts, providers/claude.ts, providers/codex.ts, types.ts, utils.ts) handles session file parsing, JSONL indexing, and streaming JSON output. This is **orthogonal** to the extension system -- it's about understanding session history, not about spawning or picking CLI panes. These files stay as-is.

### Extension manifest schema: new CLI fields

The existing `CliConfigSchema` in `server/extension-manifest.ts` has `{ command, args?, env? }`. For the migration to be complete, we need additional fields that currently live in `CodingCliCommandSpec`:
- `envVar`: environment variable that overrides the command (e.g., `CLAUDE_CMD`)
- `resumeArgs`: template for session resume arguments
- `supportsPermissionMode`: whether the CLI accepts `--permission-mode`
- `label` is already on the top-level manifest

These will be added as optional fields on the `CliConfigSchema`.

---

### Task 1: Extend the extension manifest schema for CLI spawn fields

The existing `CliConfigSchema` only has `{ command, args?, env? }`. To fully replace `CodingCliCommandSpec`, we need the additional spawn-related fields.

**Files:**
- Modify: `server/extension-manifest.ts`
- Modify: `shared/extension-types.ts`

**Step 1: Add fields to `CliConfigSchema` in `server/extension-manifest.ts`**

```typescript
const CliConfigSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  envVar: z.string().optional(),     // env var to override command (e.g., 'CLAUDE_CMD')
  resumeArgs: z.array(z.string()).optional(), // template with {{sessionId}} placeholder
  supportsPermissionMode: z.boolean().optional(),
})
```

**Step 2: Add `cli` fields to `ClientExtensionEntry` in `shared/extension-types.ts`**

```typescript
export interface ClientExtensionEntry {
  // ... existing fields ...
  cli?: {
    supportsPermissionMode?: boolean
    supportsResume?: boolean
  }
}
```

**Step 3: Update `toClientRegistry()` in `server/extension-manager.ts` to populate `cli` field**

```typescript
if (manifest.category === 'cli' && manifest.cli) {
  clientEntry.cli = {
    supportsPermissionMode: manifest.cli.supportsPermissionMode,
    supportsResume: !!manifest.cli.resumeArgs,
  }
}
```

**Step 4: Commit**

```bash
git add server/extension-manifest.ts shared/extension-types.ts server/extension-manager.ts
git commit -m "feat: extend CLI extension manifest with spawn fields (envVar, resumeArgs, supportsPermissionMode)"
```

---

### Task 2: Create extension manifest files for all existing CLIs

**Files:**
- Create: `extensions/claude-code/freshell.json`
- Create: `extensions/codex-cli/freshell.json`
- Create: `extensions/opencode/freshell.json`
- Create: `extensions/gemini/freshell.json`
- Create: `extensions/kimi/freshell.json`

**Step 1: Create Claude Code extension manifest**

Create `extensions/claude-code/freshell.json`:
```json
{
  "name": "claude",
  "version": "1.0.0",
  "label": "Claude CLI",
  "description": "Anthropic's Claude Code CLI agent",
  "category": "cli",
  "cli": {
    "command": "claude",
    "envVar": "CLAUDE_CMD",
    "resumeArgs": ["--resume", "{{sessionId}}"],
    "supportsPermissionMode": true
  },
  "picker": {
    "shortcut": "L",
    "group": "agents"
  }
}
```

**Step 2: Create Codex CLI extension manifest**

Create `extensions/codex-cli/freshell.json`:
```json
{
  "name": "codex",
  "version": "1.0.0",
  "label": "Codex CLI",
  "description": "OpenAI's Codex CLI agent",
  "category": "cli",
  "cli": {
    "command": "codex",
    "envVar": "CODEX_CMD",
    "resumeArgs": ["resume", "{{sessionId}}"]
  },
  "picker": {
    "shortcut": "X",
    "group": "agents"
  }
}
```

**Step 3: Create OpenCode extension manifest**

Create `extensions/opencode/freshell.json`:
```json
{
  "name": "opencode",
  "version": "1.0.0",
  "label": "OpenCode",
  "description": "OpenCode CLI agent",
  "category": "cli",
  "cli": {
    "command": "opencode",
    "envVar": "OPENCODE_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 4: Create Gemini extension manifest**

Create `extensions/gemini/freshell.json`:
```json
{
  "name": "gemini",
  "version": "1.0.0",
  "label": "Gemini",
  "description": "Google's Gemini CLI agent",
  "category": "cli",
  "cli": {
    "command": "gemini",
    "envVar": "GEMINI_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 5: Create Kimi extension manifest**

Create `extensions/kimi/freshell.json`:
```json
{
  "name": "kimi",
  "version": "1.0.0",
  "label": "Kimi",
  "description": "Kimi CLI agent",
  "category": "cli",
  "cli": {
    "command": "kimi",
    "envVar": "KIMI_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

**Step 6: Verify manifests are valid**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import fs from 'fs';
import { ExtensionManifestSchema } from './server/extension-manifest.js';
for (const dir of ['extensions/claude-code', 'extensions/codex-cli', 'extensions/opencode', 'extensions/gemini', 'extensions/kimi']) {
  const raw = JSON.parse(fs.readFileSync(dir + '/freshell.json', 'utf-8'));
  const result = ExtensionManifestSchema.safeParse(raw);
  console.log(dir, result.success ? 'VALID' : result.error.format());
}
"
```

**Step 7: Commit**

```bash
git add extensions/
git commit -m "feat: add CLI extension manifests for all existing CLI agents"
```

---

### Task 3: Add repo-local extensions directory to scan path

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

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npx tsx -e "
import { ExtensionManager } from './server/extension-manager.js';
const mgr = new ExtensionManager();
mgr.scan(['./extensions']);
console.log('Found:', mgr.getAll().map(e => e.manifest.name));
"
```

Expected output: `Found: [ 'claude', 'codex', 'opencode', 'gemini', 'kimi' ]`

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: scan repo extensions/ directory for built-in CLI extensions"
```

---

### Task 4: Remove hardcoded CLI registrations from `terminal-registry.ts` and derive from extensions

This is the core task. We remove `CODING_CLI_COMMANDS` as a hardcoded `Record` and replace it with a `Map<string, CodingCliCommandSpec>` built from extension data injected via the `TerminalRegistry` constructor. `TerminalMode` widens to `'shell' | string`.

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/index.ts`

**Step 1: Widen `TerminalMode` and convert `CODING_CLI_COMMANDS` to a dynamic Map**

In `server/terminal-registry.ts`:

```typescript
// TerminalMode is now a wider type -- any string is valid as a mode name.
// 'shell' is the only built-in; all CLI modes come from registered extensions.
export type TerminalMode = 'shell' | (string & {})
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  resumeArgs?: (sessionId: string) => string[]
  supportsPermissionMode?: boolean
}

// Mutable map, populated at startup from extension registry.
// No longer a hardcoded Record -- extensions are the single source of truth.
let codingCliCommands: Map<string, CodingCliCommandSpec> = new Map()

/**
 * Populate the CLI commands map from extension data.
 * Called once at server startup after extensions are scanned.
 */
export function registerCodingCliCommands(specs: Map<string, CodingCliCommandSpec>): void {
  codingCliCommands = specs
}
```

**IMPORTANT:** The `providerNotificationArgs()` function (line 168) has Claude-specific bell/hook args and Codex-specific skill args. These are provider-specific behaviors that cannot be generalized to arbitrary extensions. Keep this function as-is -- it returns `[]` for unknown modes, which is correct for new extensions.

**Step 2: Update all functions that referenced the hardcoded Record**

`modeSupportsResume`:
```typescript
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!codingCliCommands.get(mode)?.resumeArgs
}
```

`resolveCodingCliCommand`:
```typescript
function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string, target: ProviderTarget = 'unix', providerSettings?: ProviderSettings) {
  if (mode === 'shell') return null
  const spec = codingCliCommands.get(mode)
  if (!spec) return null
  const command = process.env[spec.envVar] || spec.defaultCommand
  const providerArgs = providerNotificationArgs(mode, target)
  // ... rest unchanged
}
```

`getModeLabel`:
```typescript
function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = codingCliCommands.get(mode)?.label
  return label || mode.charAt(0).toUpperCase() + mode.slice(1)
}
```

`normalizeResumeSessionId` -- change param type from `TerminalMode` to `string`:
```typescript
function normalizeResumeSessionId(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  // unchanged body
}
```

The `TerminalRecord` type already uses `mode: TerminalMode` which is now `'shell' | string`, so no change needed.

**Step 3: Build CLI commands map in `server/index.ts`**

After `extensionManager.scan(...)` and before `new TerminalRegistry(...)`:

```typescript
import { registerCodingCliCommands, type CodingCliCommandSpec } from './terminal-registry.js'

// Build CLI commands from extension manifests
const cliCommandsMap = new Map<string, CodingCliCommandSpec>()
for (const ext of extensionManager.getAll()) {
  if (ext.manifest.category !== 'cli' || !ext.manifest.cli) continue
  const cli = ext.manifest.cli
  const spec: CodingCliCommandSpec = {
    label: ext.manifest.label,
    envVar: cli.envVar || '',
    defaultCommand: cli.command,
    supportsPermissionMode: cli.supportsPermissionMode,
  }
  if (cli.resumeArgs) {
    const template = cli.resumeArgs
    spec.resumeArgs = (sessionId: string) =>
      template.map(arg => arg.replace('{{sessionId}}', sessionId))
  }
  cliCommandsMap.set(ext.manifest.name, spec)
}
registerCodingCliCommands(cliCommandsMap)
```

**Step 4: Commit**

```bash
git add server/terminal-registry.ts server/index.ts
git commit -m "feat: derive CODING_CLI_COMMANDS from extension manifests (single source of truth)"
```

---

### Task 5: Remove hardcoded `CLI_COMMANDS` from `platform.ts` and derive from extensions

**Files:**
- Modify: `server/platform.ts`
- Modify: `server/index.ts`
- Modify: `server/platform-router.ts`

**Step 1: Remove `CLI_COMMANDS` constant and change `detectAvailableClis` to accept the CLI list as a parameter**

In `server/platform.ts`, remove the `CLI_COMMANDS` constant and change `detectAvailableClis`:

```typescript
// Remove this:
// const CLI_COMMANDS = [
//   { name: 'claude', envVar: 'CLAUDE_CMD', defaultCmd: 'claude' },
//   ...
// ] as const

export type CliDetectionSpec = { name: string; envVar: string; defaultCmd: string }

export async function detectAvailableClis(
  cliSpecs: CliDetectionSpec[],
): Promise<AvailableClis> {
  const results = await Promise.all(
    cliSpecs.map(async (cli) => {
      const cmd = cli.envVar ? (process.env[cli.envVar] || cli.defaultCmd) : cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )
  return Object.fromEntries(results)
}
```

**Step 2: Build CLI specs from extension registry in `server/index.ts`**

```typescript
// Build CLI detection specs from extension manifests
const cliDetectionSpecs: CliDetectionSpec[] = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli' && e.manifest.cli)
  .map(e => ({
    name: e.manifest.name,
    envVar: e.manifest.cli!.envVar || '',
    defaultCmd: e.manifest.cli!.command,
  }))
```

**Step 3: Pass CLI specs to `createPlatformRouter`**

In `server/index.ts`, change the platform router deps:
```typescript
app.use('/api', createPlatformRouter({
  detectPlatform,
  detectAvailableClis: () => detectAvailableClis(cliDetectionSpecs),
  detectHostName,
  checkForUpdate,
  appVersion: APP_VERSION,
}))
```

The `PlatformRouterDeps` interface already expects `detectAvailableClis: () => Promise<Record<string, boolean>>`, so no change needed there. The caller in `index.ts` wraps the function to bind the parameter.

**Step 4: Commit**

```bash
git add server/platform.ts server/index.ts
git commit -m "feat: derive CLI availability detection from extension registry"
```

---

### Task 6: Make `CodingCliProviderSchema` dynamic in WS protocol schemas

The `CodingCliProviderSchema` is a hardcoded `z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])` in `shared/ws-protocol.ts`. It's used in `SessionLocatorSchema`, `TerminalMetaRecordSchema`, `CodingCliCreateSchema`, and `TerminalCreateSchema`. New CLI extensions added via manifests would be rejected by these schemas.

**Files:**
- Modify: `shared/ws-protocol.ts` -- export factory functions for dynamic schemas
- Modify: `server/ws-handler.ts` -- build schemas dynamically using extension data
- Modify: `server/ws-schemas.ts` -- remove duplicate schemas, import from shared

**Step 1: In `shared/ws-protocol.ts`, replace hardcoded enum with factory functions**

Replace:
```typescript
export const CodingCliProviderSchema = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])
export type CodingCliProviderName = z.infer<typeof CodingCliProviderSchema>
```

With:
```typescript
/**
 * Build a provider schema that validates against a dynamic set of known CLI provider names.
 * Used instead of z.enum() so that extension-registered CLIs are accepted.
 */
export function createCodingCliProviderSchema(validProviders: string[]) {
  const providerSet = new Set(validProviders)
  return z.string().min(1).refine(
    (val) => providerSet.has(val),
    (val) => ({ message: `Unknown CLI provider: '${val}'. Valid providers: ${[...providerSet].join(', ')}` }),
  )
}

// Default schema with no providers -- overridden at server startup.
// Client code uses `import type` so this is only used at runtime on the server.
export let CodingCliProviderSchema: z.ZodType<string> = z.string().min(1)

// Type is now just string (was a narrow union derived from z.enum)
export type CodingCliProviderName = string

/**
 * Initialize the shared schemas with the set of valid CLI provider names.
 * Called once at server startup after extensions are scanned.
 */
export function initWsProtocolSchemas(validProviders: string[]): void {
  CodingCliProviderSchema = createCodingCliProviderSchema(validProviders)
}
```

Also change `TerminalCreateSchema.mode`:
```typescript
// Before: mode: z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi']).default('shell'),
// After:
export function createTerminalCreateSchema(validModes: string[]) {
  const modeSet = new Set(['shell', ...validModes])
  return z.object({
    type: z.literal('terminal.create'),
    requestId: z.string().min(1),
    mode: z.string().default('shell').refine(
      (val) => modeSet.has(val),
      (val) => ({ message: `Invalid terminal mode: '${val}'. Valid modes: ${[...modeSet].join(', ')}` }),
    ),
    shell: ShellSchema.default('system'),
    cwd: z.string().optional(),
    resumeSessionId: z.string().optional(),
    restore: z.boolean().optional(),
    tabId: z.string().min(1).optional(),
    paneId: z.string().min(1).optional(),
  })
}

// Default export kept for backward compatibility (tests, client-side code that doesn't validate)
export let TerminalCreateSchema = createTerminalCreateSchema([])
```

Keep `SessionLocatorSchema` and `TerminalMetaRecordSchema` using `CodingCliProviderSchema` -- since `CodingCliProviderSchema` is now a `let` that gets reassigned at startup, these will automatically pick up the dynamic validation.

Wait -- Zod schemas are built eagerly when the module is evaluated. `SessionLocatorSchema` captures `CodingCliProviderSchema` by value at module load time. Reassigning the `let` won't update already-built schemas.

**Revised approach:** The schemas that use `CodingCliProviderSchema` (`SessionLocatorSchema`, `TerminalMetaRecordSchema`, `CodingCliCreateSchema`, `TerminalCreateSchema`) must also be rebuilt dynamically. Export a single `initWsProtocolSchemas()` function that reassigns ALL of them:

```typescript
// Mutable module-level schemas -- initialized with permissive defaults,
// then tightened at server startup via initWsProtocolSchemas().
export let CodingCliProviderSchema: z.ZodType<string> = z.string().min(1)
export type CodingCliProviderName = string

export let SessionLocatorSchema = z.object({
  provider: z.string().min(1),
  sessionId: z.string().min(1),
  serverInstanceId: z.string().min(1).optional(),
})
export type SessionLocator = z.infer<typeof SessionLocatorSchema>

export let TerminalMetaRecordSchema = z.object({
  terminalId: z.string().min(1),
  cwd: z.string().optional(),
  checkoutRoot: z.string().optional(),
  repoRoot: z.string().optional(),
  displaySubdir: z.string().optional(),
  branch: z.string().optional(),
  isDirty: z.boolean().optional(),
  provider: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  tokenUsage: TokenSummarySchema.optional(),
  updatedAt: z.number().int().nonnegative(),
})

export let TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.string().default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  restore: z.boolean().optional(),
  tabId: z.string().min(1).optional(),
  paneId: z.string().min(1).optional(),
})

export let CodingCliCreateSchema = z.object({
  type: z.literal('codingcli.create'),
  requestId: z.string().min(1),
  provider: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
})

/**
 * Initialize all dynamic WS protocol schemas with the set of valid CLI provider names.
 * Must be called once at server startup, after extensions are scanned, before any
 * WS connections are accepted.
 */
export function initWsProtocolSchemas(validProviders: string[]): void {
  const providerSchema = createCodingCliProviderSchema(validProviders)
  CodingCliProviderSchema = providerSchema

  const allModes = new Set(['shell', ...validProviders])
  const modeSchema = z.string().default('shell').refine(
    (val) => allModes.has(val),
    (val) => ({ message: `Invalid terminal mode: '${val}'. Valid modes: ${[...allModes].join(', ')}` }),
  )

  SessionLocatorSchema = z.object({
    provider: providerSchema,
    sessionId: z.string().min(1),
    serverInstanceId: z.string().min(1).optional(),
  })

  TerminalMetaRecordSchema = z.object({
    terminalId: z.string().min(1),
    cwd: z.string().optional(),
    checkoutRoot: z.string().optional(),
    repoRoot: z.string().optional(),
    displaySubdir: z.string().optional(),
    branch: z.string().optional(),
    isDirty: z.boolean().optional(),
    provider: providerSchema.optional(),
    sessionId: z.string().optional(),
    tokenUsage: TokenSummarySchema.optional(),
    updatedAt: z.number().int().nonnegative(),
  })

  TerminalCreateSchema = z.object({
    type: z.literal('terminal.create'),
    requestId: z.string().min(1),
    mode: modeSchema,
    shell: ShellSchema.default('system'),
    cwd: z.string().optional(),
    resumeSessionId: z.string().optional(),
    restore: z.boolean().optional(),
    tabId: z.string().min(1).optional(),
    paneId: z.string().min(1).optional(),
  })

  CodingCliCreateSchema = z.object({
    type: z.literal('codingcli.create'),
    requestId: z.string().min(1),
    provider: providerSchema,
    prompt: z.string().min(1),
    cwd: z.string().optional(),
    resumeSessionId: z.string().optional(),
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  })
}
```

**Step 2: Update `server/ws-handler.ts` to rebuild `ClientMessageSchema` dynamically**

The ws-handler's `ClientMessageSchema` (line 238) includes `TerminalCreateSchema` and `CodingCliCreateSchema` which are now `let` variables. Since `z.discriminatedUnion` captures schemas by value at construction time, we must build `ClientMessageSchema` AFTER `initWsProtocolSchemas()` has been called.

Move the `ClientMessageSchema` construction from module level to the `WsHandler` constructor:

```typescript
class WsHandler {
  private clientMessageSchema: ReturnType<typeof z.discriminatedUnion>

  constructor(/* ... existing params ... */) {
    // ... existing init ...

    // Build the message schema AFTER initWsProtocolSchemas() has run
    this.clientMessageSchema = z.discriminatedUnion('type', [
      HelloSchema,
      PingSchema,
      TerminalCreateSchema,  // now the dynamic version
      TerminalAttachSchema,
      // ... rest of schemas ...
      CodingCliCreateSchema,  // now the dynamic version
      // ...
    ])
  }
```

Change the parse call at line 1086 from `ClientMessageSchema.safeParse(msg)` to `this.clientMessageSchema.safeParse(msg)`.

**Step 3: Clean up `server/ws-schemas.ts`**

This file has its own copies of `CodingCliProviderSchema`, `TerminalCreateSchema`, and `ClientMessageSchema`. Either:
- Remove the duplicates and import from `shared/ws-protocol.ts`, or
- If this file serves a different purpose (e.g., the SDK bridge), update its schemas similarly.

Check where `server/ws-schemas.ts` is imported from to determine the right approach. If nothing imports it, it may be dead code.

**Step 4: Call `initWsProtocolSchemas()` in `server/index.ts`**

In `server/index.ts`, after building the extension CLI list:

```typescript
import { initWsProtocolSchemas } from '../shared/ws-protocol.js'

// After extension scan and CLI commands registration:
const validProviders = extensionManager.getAll()
  .filter(e => e.manifest.category === 'cli')
  .map(e => e.manifest.name)
initWsProtocolSchemas(validProviders)
```

This must happen before `new WsHandler(...)`.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/ws-schemas.ts server/index.ts
git commit -m "feat: make CodingCliProviderSchema and TerminalCreateSchema dynamic"
```

---

### Task 7: Remove hardcoded CLI configs from frontend `coding-cli-utils.ts`

Currently, `src/lib/coding-cli-utils.ts` has hardcoded `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, and `CODING_CLI_PROVIDER_CONFIGS`. These must be derived from the extension entries in Redux state.

**Files:**
- Modify: `src/lib/coding-cli-utils.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/paneTypes.ts`

**Step 1: Widen `CodingCliProviderName` and `TabMode` types**

In the frontend, `CodingCliProviderName` is imported from `src/lib/coding-cli-types.ts` (which re-exports from `shared/ws-protocol.ts`). Since the shared module now exports `CodingCliProviderName = string`, the frontend automatically gets the wider type.

In `src/store/types.ts`, `TabMode` is `'shell' | CodingCliProviderName`. Since `CodingCliProviderName` is now `string`, `TabMode` effectively becomes `string`. Keep the definition for clarity:
```typescript
export type TabMode = 'shell' | CodingCliProviderName  // effectively string
```

**Step 2: Remove hardcoded arrays and records from `coding-cli-utils.ts`**

Replace the hardcoded arrays with functions that take extension entries as input:

```typescript
import type { CodingCliProviderName } from './coding-cli-types'
import type { ClientExtensionEntry } from '@shared/extension-types'

// REMOVED: CODING_CLI_PROVIDERS, CODING_CLI_PROVIDER_LABELS, CODING_CLI_PROVIDER_CONFIGS
// These are now derived from extension entries in Redux state.

export function getCliProviders(extensions: ClientExtensionEntry[]): CodingCliProviderName[] {
  return extensions
    .filter(e => e.category === 'cli')
    .map(e => e.name)
}

export function getProviderLabel(provider?: string, extensions?: ClientExtensionEntry[]): string {
  if (!provider) return 'CLI'
  const ext = extensions?.find(e => e.name === provider && e.category === 'cli')
  if (ext) return ext.label
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function isCodingCliProviderName(value?: string, extensions?: ClientExtensionEntry[]): value is CodingCliProviderName {
  if (!value) return false
  if (!extensions) return false
  return extensions.some(e => e.category === 'cli' && e.name === value)
}

export function isCodingCliMode(mode?: string, extensions?: ClientExtensionEntry[]): boolean {
  if (!mode || mode === 'shell') return false
  return isCodingCliProviderName(mode, extensions)
}

// Keep resume-related functions -- these are inherently provider-specific
export type ResumeCommandProvider = string

export function isResumeCommandProvider(value?: string, extensions?: ClientExtensionEntry[]): value is ResumeCommandProvider {
  if (!value) return false
  const ext = extensions?.find(e => e.name === value && e.category === 'cli')
  return !!ext?.cli?.supportsResume
}

export function buildResumeCommand(provider?: string, sessionId?: string): string | null {
  if (!sessionId) return null
  // These are provider-specific command formats -- kept as special cases
  // since the resume command syntax varies per provider
  if (provider === 'claude') return `claude --resume ${sessionId}`
  if (provider === 'codex') return `codex resume ${sessionId}`
  return null
}
```

**Step 3: Update all callers of the removed constants**

Every file that imports `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, or `CODING_CLI_PROVIDER_CONFIGS` must be updated to get extension entries from Redux and pass them to the new functions. The exact callers need to be found via grep and updated one by one.

Key callers to update:
- `src/components/panes/PanePicker.tsx` -- uses `CODING_CLI_PROVIDER_CONFIGS` to build picker options
- `src/components/panes/PaneContainer.tsx` -- uses `isCodingCliMode` for content creation
- `src/lib/derivePaneTitle.ts` -- uses `getProviderLabel` for titles
- `src/store/` slices that reference provider names

**Step 4: Commit**

```bash
git add src/lib/coding-cli-utils.ts src/store/types.ts src/store/paneTypes.ts
git commit -m "feat: derive CLI provider configs from extension entries instead of hardcoded lists"
```

---

### Task 8: Wire CLI extensions into PanePicker and PaneContainer

Currently, when a CLI extension (`ext:name`) is selected from the PanePicker, it creates an `ExtensionPaneContent` (kind: 'extension'). But CLI extensions should create a `TerminalPaneContent` (kind: 'terminal') with the extension name as the `mode`.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` - route CLI extensions to terminal pane creation
- Modify: `src/components/panes/PanePicker.tsx` - route CLI extensions through the directory picker

**Step 1: In PaneContainer.tsx, handle CLI extensions in createContentForType**

Before the generic `ext:` handler, add a check for CLI extensions:

```typescript
const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? [])

const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
  if (typeof type === 'string' && type.startsWith('ext:')) {
    const extensionName = type.slice(4)
    const ext = extensionEntries.find(e => e.name === extensionName)
    if (ext?.category === 'cli') {
      return {
        kind: 'terminal' as const,
        mode: extensionName,
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
  // ... rest of existing cases unchanged
}, [extensionEntries, settings])
```

**Step 2: In PanePicker.tsx `handleSelect`, route CLI extensions through the directory picker**

```typescript
const handleSelect = useCallback((type: PanePickerType) => {
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

### Task 9: Update `settings-router.ts` hardcoded provider names

The `settings-router.ts` has its own hardcoded `CODING_CLI_PROVIDER_NAMES` constant (line 8) and uses it in schema validation for `codingCli.enabledProviders` and `codingCli.providers`. This needs to accept extension-registered providers.

**Files:**
- Modify: `server/settings-router.ts`

**Step 1: Make `SettingsPatchSchema` accept dynamic provider names**

The `SettingsPatchSchema` in `server/settings-router.ts` has:
```typescript
const CODING_CLI_PROVIDER_NAMES = ['claude', 'codex', 'opencode', 'gemini', 'kimi'] as const

codingCli: z.object({
  enabledProviders: z.array(z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])).optional(),
  providers: z.record(z.string(), CodingCliProviderConfigSchema)
    .refine(
      (obj) => Object.keys(obj).every((k) => (CODING_CLI_PROVIDER_NAMES as readonly string[]).includes(k)),
      { message: 'Unknown provider name' },
    )
    .optional(),
})
```

Change `createSettingsRouter` to accept extension manager data and build the schema dynamically:

```typescript
export interface SettingsRouterDeps {
  // ... existing fields ...
  validProviderNames: string[]  // NEW: from extension registry
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const { configStore, registry, wsHandler, codingCliIndexer, perfConfig, applyDebugLogging, validProviderNames } = deps

  const providerNameSet = new Set(validProviderNames)

  const settingsPatchSchema = z.object({
    // ... existing fields ...
    codingCli: z.object({
      enabledProviders: z.array(
        z.string().refine(v => providerNameSet.has(v), { message: 'Unknown provider name' })
      ).optional(),
      providers: z.record(z.string(), CodingCliProviderConfigSchema)
        .refine(
          (obj) => Object.keys(obj).every((k) => providerNameSet.has(k)),
          { message: 'Unknown provider name' },
        )
        .optional(),
    }).strict().optional(),
    // ... rest unchanged ...
  }).strict()

  // Use settingsPatchSchema instead of the module-level SettingsPatchSchema
```

**Step 2: Pass `validProviderNames` in `server/index.ts`**

```typescript
app.use('/api/settings', createSettingsRouter({
  configStore,
  registry,
  wsHandler,
  codingCliIndexer,
  perfConfig,
  applyDebugLogging,
  validProviderNames: validProviders,  // from extension scan
}))
```

**Step 3: Commit**

```bash
git add server/settings-router.ts server/index.ts
git commit -m "feat: settings schema accepts dynamically-registered CLI provider names"
```

---

### Task 10: End-to-end smoke test via live UI

**Testing approach:** Since the user specified "No unit tests only. You should actually make sure this works", we validate through the live UI on port :5173.

**Step 1: Start the dev server in the worktree**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

**Step 2: Verify extension scan in logs**

```bash
grep "Extension scan" /tmp/freshell-3344.log
# Should show: Extension scan complete { count: 5+, names: ['claude', 'codex', 'opencode', 'gemini', 'kimi'] }
```

**Step 3: Verify API endpoint**

```bash
curl http://localhost:3344/api/extensions | jq '.[].name'
# Should include "claude", "codex", "opencode", "gemini", "kimi"

curl http://localhost:3344/api/platform | jq '.availableClis'
# Should include entries for all registered CLI extensions
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

### Task 11: Run full test suite and fix any regressions

**Step 1: Run all tests**

```bash
cd /home/user/code/freshell/.worktrees/extensions-system
npm test
```

**Step 2: Fix any failures**

The most likely failures will be:
- Tests that construct `TerminalRegistry` -- the constructor signature is unchanged, but tests that use `TerminalMode` as a narrow type may need updating
- Tests that test `TerminalCreateSchema.mode` or `CodingCliProviderSchema` enum values -- these now use dynamic schemas that need initialization
- Tests that check `availableClis` detection -- `detectAvailableClis` now requires a parameter
- Tests that import `CODING_CLI_PROVIDERS` or `CODING_CLI_PROVIDER_LABELS` -- these are removed

For test files that need initialized schemas, add a `beforeAll` or test helper that calls `initWsProtocolSchemas([...])` with the expected provider names.

For test files that need `registerCodingCliCommands`, add a setup that builds the map from test fixtures.

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

1. **Extension manifests are the single source of truth.** The hardcoded `CODING_CLI_COMMANDS`, `CLI_COMMANDS`, `CODING_CLI_PROVIDERS`, `CODING_CLI_PROVIDER_LABELS`, and `CODING_CLI_PROVIDER_CONFIGS` are all removed. CLI registration is defined solely in extension manifest files, and all runtime data structures are built from those manifests at server startup.

2. **`TerminalMode` becomes `'shell' | string`.** Since `CODING_CLI_COMMANDS` is now a dynamic `Map`, there is no static `Record` type to protect. No dual-type system (`TerminalModeOrExtension`) is needed. On the frontend, `TabMode` and `CodingCliProviderName` also widen to `string`.

3. **WS protocol schemas are initialized dynamically.** `CodingCliProviderSchema`, `SessionLocatorSchema`, `TerminalMetaRecordSchema`, `TerminalCreateSchema`, and `CodingCliCreateSchema` are mutable module-level variables reassigned by `initWsProtocolSchemas()` at server startup, before any WS connections are accepted. This ensures Zod validation rejects unknown providers/modes while accepting extension-registered ones.

4. **Provider-specific notification logic stays in `terminal-registry.ts`.** The `providerNotificationArgs()` function has Claude-specific hook/bell args and Codex-specific skill args. These are inherently provider-specific behaviors that return `[]` for unknown modes, which is correct for new extensions. Moving them to manifests would require a much more complex template system.

5. **Settings schema validation is dynamic.** `SettingsPatchSchema` in `server/settings-router.ts` accepts extension-registered provider names for `codingCli.enabledProviders` and `codingCli.providers`, so user settings for new CLI extensions are accepted.

6. **Extension data flows via dependency injection.** `registerCodingCliCommands()` is called at startup. `detectAvailableClis()` takes CLI specs as a parameter. `initWsProtocolSchemas()` takes valid providers as a parameter. `createSettingsRouter()` takes `validProviderNames`. This follows the codebase's existing DI patterns.

7. **Session indexing is orthogonal.** The `server/coding-cli/providers/` directory handles session file parsing and is not part of the extension system. A future task could make session indexers discoverable via extensions.

8. **All changes target `server/terminal-registry.ts`, not `server/spawn-spec.ts`.** `spawn-spec.ts` is dead code (never imported by production files).

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits
- The live server on main must never be broken
- Work in the worktree at `/home/user/code/freshell/.worktrees/extensions-system`
