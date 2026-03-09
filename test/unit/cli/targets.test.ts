import { it, expect } from 'vitest'
import { resolveTarget } from '../../../server/cli/targets'

it('resolves pane index in active tab', () => {
  const res = resolveTarget('0', { activeTabId: 't1', panesByTab: { t1: ['p1'] }, tabs: [] })
  expect(res.paneId).toBe('p1')
})

it('resolves pane title targets', () => {
  const res = resolveTarget('Docs review', {
    activeTabId: 't1',
    panesByTab: {
      t1: [
        { id: 'p1', title: 'Shell' },
        { id: 'p2', title: 'Docs review' },
      ],
    },
    tabs: [{ id: 't1', title: 'Workspace', activePaneId: 'p1' }],
  } as any)

  expect(res.tabId).toBe('t1')
  expect(res.paneId).toBe('p2')
})

it('prefers documented index and tab selectors over pane title collisions', () => {
  const ctx = {
    activeTabId: 't1',
    panesByTab: {
      t1: [
        { id: 'p1', title: 'Shell' },
        { id: 'p2', title: 'Editor' },
      ],
      t2: [
        { id: 'p3', title: '0' },
        { id: 'p4', title: 'alpha.1' },
      ],
    },
    tabs: [
      { id: 't1', title: 'alpha', activePaneId: 'p1' },
      { id: 't2', title: 'alpha.1', activePaneId: 'p3' },
    ],
  } as any

  expect(resolveTarget('0', ctx)).toMatchObject({ tabId: 't1', paneId: 'p1' })
  expect(resolveTarget('alpha.1', ctx)).toMatchObject({ tabId: 't2', paneId: 'p3' })
})
