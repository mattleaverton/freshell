// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { VisibleFirstAuditSchema } from '@test/e2e-browser/perf/audit-contract'
import { runVisibleFirstAudit } from '@test/e2e-browser/perf/run-visible-first-audit'

describe('runVisibleFirstAudit', () => {
  it('runs the accepted scenario/profile matrix in stable order and returns a schema-valid object', async () => {
    const artifact = await runVisibleFirstAudit({
      scenarioIds: ['auth-required-cold-boot', 'terminal-cold-boot'],
      profileIds: ['desktop_local', 'mobile_restricted'],
      deps: {
        runSample: async ({ scenarioId, profileId }) => ({
          profileId,
          status: 'ok',
          startedAt: '2026-03-10T00:00:00.000Z',
          finishedAt: '2026-03-10T00:00:01.000Z',
          durationMs: 1000,
          browser: {},
          transport: {},
          server: {},
          derived: {
            focusedReadyMs: scenarioId === 'auth-required-cold-boot' ? 25 : 50,
          },
          errors: [],
        }),
        getGitInfo: async () => ({
          commit: 'abc123',
          branch: 'codex/visible-first-perf-audit',
          dirty: false,
        }),
        getBrowserVersion: async () => 'Chromium 123',
        getNowIso: () => '2026-03-10T00:00:02.000Z',
      },
    })

    expect(artifact.scenarios.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
    ])
    expect(artifact.scenarios.every((scenario) => scenario.samples.length === 2)).toBe(true)
    expect(() => VisibleFirstAuditSchema.parse(artifact)).not.toThrow()
  })
})
