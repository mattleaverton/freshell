# Implementation Plan: Detect Non-Interactive Claude Code Sessions

## Problem

Automated Claude Code sessions (started via `claude -p` for piped/non-interactive mode)
appear in the Freshell sidebar alongside regular interactive sessions. These come from
kilroy attractor runs and trycycle worktree subagents and should be hidden by default.

## Root Cause

The Claude provider's `parseSessionContent()` function does not detect non-interactive
sessions. Unlike the Codex provider (which checks for `source === 'exec'`), Claude's
piped-mode sessions have a different structural signature: their JSONL files contain
`queue-operation` type events (with subtypes like `enqueue` and `dequeue`) that
interactive sessions never produce.

## Existing Infrastructure (No Changes Needed)

The downstream pipeline is already fully wired:

1. **`ParsedSessionMeta`** (`server/coding-cli/types.ts:128`) already has
   `isNonInteractive?: boolean`
2. **`CodingCliSession`** (`server/coding-cli/types.ts:156`) already has
   `isNonInteractive?: boolean`
3. **`updateCacheEntry()`** (`server/coding-cli/session-indexer.ts:435`) already
   propagates: `isNonInteractive: meta.isNonInteractive || undefined`
4. **`SidebarSessionItem`** (`src/store/selectors/sidebarSelectors.ts:24`) already has
   `isNonInteractive?: boolean`
5. **`filterSessionItemsByVisibility()`** (`src/store/selectors/sidebarSelectors.ts:171`)
   already filters: `if (!settings.showNoninteractiveSessions && item.isNonInteractive) return false`
6. **`showNoninteractiveSessions`** setting defaults to `false`

The only gap is in the Claude provider's session parser.

## Changes Required

### File 1: `server/coding-cli/providers/claude.ts`

**Change A: Add `isNonInteractive` to `JsonlMeta` type (line 12)**

The `JsonlMeta` type is the return type of `parseSessionContent()`. It currently lacks
`isNonInteractive`, which means the function cannot return it. Since `parseSessionFile()`
returns `ParsedSessionMeta` (which does have the field), the implicit structural typing
works -- but only if `JsonlMeta` also declares the field.

Add `isNonInteractive?: boolean` to the `JsonlMeta` type alongside the existing fields.

**Change B: Detect `queue-operation` events in `parseSessionContent()` (line 239)**

Inside the `for (const line of lines)` loop, after parsing each JSON object, check if
`obj.type === 'queue-operation'`. If so, set a local `isNonInteractive` flag to `true`.

This mirrors the Codex pattern where `isNonInteractive` is set based on a provider-specific
signal (`payload.source === 'exec'` for Codex, `obj.type === 'queue-operation'` for Claude).

The detection should be a simple boolean latch (once true, stays true) -- there is no need
to check every line, but since we are iterating anyway, the check is trivially cheap.

**Change C: Return `isNonInteractive` from `parseSessionContent()`**

Add `isNonInteractive` to the return object (alongside `sessionId`, `cwd`, `title`, etc.).

### File 2: `test/unit/server/coding-cli/claude-provider.test.ts`

Add a new `describe` block: `parseSessionContent() - non-interactive detection` with
these test cases:

1. **Sets `isNonInteractive` when content contains a `queue-operation` event**
   - Build JSONL content with a `queue-operation` event (`{ "type": "queue-operation",
     "subtype": "enqueue", ... }`) followed by normal session events with cwd and user
     message
   - Assert `parseSessionContent(content).isNonInteractive` is `true`

2. **Does not set `isNonInteractive` for normal interactive sessions**
   - Build JSONL content with typical interactive session events (`file-history-snapshot`,
     user message with cwd, assistant message)
   - Assert `parseSessionContent(content).isNonInteractive` is falsy (undefined)

3. **Does not set `isNonInteractive` for sessions with only `file-history-snapshot` events**
   - Build JSONL content with only `file-history-snapshot` events (orphaned sessions)
   - Assert `parseSessionContent(content).isNonInteractive` is falsy (undefined)

4. **Sets `isNonInteractive` even when `queue-operation` is not the first line**
   - Build JSONL content where a `file-history-snapshot` precedes the `queue-operation`
   - Assert `parseSessionContent(content).isNonInteractive` is `true`

### File 3: `test/unit/server/coding-cli/session-visibility.test.ts`

Add a new `describe` block: `Claude isNonInteractive detection` (parallel to the existing
`Codex isNonInteractive detection` block) with these test cases:

1. **Sets `isNonInteractive` when `queue-operation` events are present**
   - Mirrors the Codex `source: 'exec'` test but uses Claude JSONL format
   - Assert `parseSessionContent(content).isNonInteractive` is `true`

2. **Does not set `isNonInteractive` for normal Claude sessions**
   - Build typical interactive Claude session content
   - Assert `parseSessionContent(content).isNonInteractive` is falsy

## TDD Execution Order

### Red Phase
1. Write all test cases in `claude-provider.test.ts` and `session-visibility.test.ts`
2. Run tests -- they should fail because `parseSessionContent` does not return
   `isNonInteractive`

### Green Phase
3. Add `isNonInteractive?: boolean` to `JsonlMeta` type
4. Add `let isNonInteractive: boolean | undefined` variable in `parseSessionContent()`
5. Add detection logic: `if (obj.type === 'queue-operation') isNonInteractive = true`
6. Add `isNonInteractive` to the return object
7. Run tests -- all should pass

### Refactor Phase
8. Review the detection logic for clarity and consistency with Codex's pattern
9. Ensure no unnecessary complexity was introduced
10. Run full test suite (`npm test`) to confirm no regressions

## Risk Assessment

**Very low risk.** This change:
- Adds a single field to a type and a single conditional check to an existing loop
- Does not modify any existing behavior -- sessions that don't have `queue-operation`
  events continue to work exactly as before
- The downstream filtering pipeline is already tested and working (proven by Codex's
  `isNonInteractive` flow and the existing `sidebarSelectors.visibility.test.ts`)
- No new dependencies, no new files, no architectural changes

## Files Modified (Summary)

| File | Change |
|------|--------|
| `server/coding-cli/providers/claude.ts` | Add `isNonInteractive` to `JsonlMeta`, detect `queue-operation`, return flag |
| `test/unit/server/coding-cli/claude-provider.test.ts` | Add non-interactive detection tests |
| `test/unit/server/coding-cli/session-visibility.test.ts` | Add Claude non-interactive tests |

## Verification

1. `npm test` -- all existing + new tests pass
2. The sidebar toggle "Show non-interactive sessions" (already exists) controls visibility
3. With the toggle off (default), `claude -p` sessions no longer appear in the sidebar
4. With the toggle on, they reappear as before
