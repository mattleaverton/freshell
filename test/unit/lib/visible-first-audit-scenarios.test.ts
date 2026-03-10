// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('visible-first audit scenarios', () => {
  it('defines the six accepted scenarios in stable order', () => {
    expect(AUDIT_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
  })
})
