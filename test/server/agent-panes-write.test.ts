import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('splits a pane horizontally', async () => {
  const app = express()
  app.use(express.json())
  const splitPane = vi.fn(() => ({ newPaneId: 'pane_new', tabId: 'tab_1' }))
  const attachPaneContent = vi.fn()
  const registryCreate = vi.fn(() => ({ terminalId: 'term_new' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: { splitPane, attachPaneContent },
    registry: { create: registryCreate },
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/pane_1/split').send({ direction: 'horizontal' })
  expect(res.body.status).toBe('ok')
  expect(res.body.data.paneId).toBe('pane_new')
  expect(registryCreate).toHaveBeenCalled()
  expect(registryCreate).toHaveBeenCalledWith(expect.objectContaining({
    envContext: { tabId: 'tab_1', paneId: 'pane_new' },
  }))
  expect(attachPaneContent).toHaveBeenCalled()
})

it('resolves tmux-style pane targets for close', async () => {
  const app = express()
  app.use(express.json())
  const closePane = vi.fn(() => ({ tabId: 'tab_1' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      closePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_resolved' }),
    },
    registry: {},
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/1.0/close').send({})
  expect(res.body.status).toBe('ok')
  expect(closePane).toHaveBeenCalledWith('pane_resolved')
})

it('rejects blank pane rename payloads', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane },
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: '   ' })

  expect(res.status).toBe(400)
  expect(renamePane).not.toHaveBeenCalled()
})

it('renames a resolved pane via PATCH /api/panes/:id', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_real' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_real' }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/1.0').send({ name: '  Logs  ' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_real', 'Logs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_real', title: 'Logs' },
  })
})

it('syncs the tab title when renaming the only pane in a tab', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const renameTab = vi.fn(() => ({ tabId: 'tab_1' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      renameTab,
      listPanes: () => [{ id: 'pane_1' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Docs' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Docs')
  expect(renameTab).toHaveBeenCalledWith('tab_1', 'Docs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Docs' },
  })
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'tab.rename',
    payload: { id: 'tab_1', title: 'Docs' },
  })
})

it('persists syncable coding CLI pane renames through terminal overrides and session overrides', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'codex', terminalId: 'term_1' },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Agent')
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Agent' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
})

it('does not broadcast pane.rename when the pane does not exist', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ message: 'pane not found' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane },
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/missing').send({ name: 'Ghost' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('missing', 'Ghost')
  expect(broadcastUiCommand).not.toHaveBeenCalled()
})
