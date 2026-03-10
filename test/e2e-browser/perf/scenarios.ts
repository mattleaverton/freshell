import type { AuditProfileId } from './profiles.js'

export type AuditScenarioId =
  | 'auth-required-cold-boot'
  | 'terminal-cold-boot'
  | 'agent-chat-cold-boot'
  | 'sidebar-search-large-corpus'
  | 'terminal-reconnect-backlog'
  | 'offscreen-tab-selection'

export type AuditScenarioContext = {
  token?: string
  profileId: AuditProfileId
}

export type AuditScenarioDefinition = {
  id: AuditScenarioId
  description: string
  focusedReadyMilestone: string
  allowedApiRouteIdsBeforeReady: readonly string[]
  allowedWsTypesBeforeReady: readonly string[]
  buildUrl: (context: AuditScenarioContext) => string
  seedServerHome?: () => Promise<void>
  seedBrowserStorage?: () => Record<string, string>
  driveInteraction?: () => Promise<void>
}

function buildRootUrl(token?: string): string {
  const params = new URLSearchParams({ e2e: '1', perfAudit: '1' })
  if (token) {
    params.set('token', token)
  }
  return `/?${params.toString()}`
}

export const AUDIT_SCENARIOS: readonly AuditScenarioDefinition[] = [
  {
    id: 'auth-required-cold-boot',
    description: 'Cold boot without a token until the auth gate is visible.',
    focusedReadyMilestone: 'app.auth_required_visible',
    allowedApiRouteIdsBeforeReady: ['/api/settings'],
    allowedWsTypesBeforeReady: [],
    buildUrl: () => buildRootUrl(),
  },
  {
    id: 'terminal-cold-boot',
    description: 'Cold boot into a focused terminal pane until first output is visible.',
    focusedReadyMilestone: 'terminal.first_output',
    allowedApiRouteIdsBeforeReady: ['/api/settings', '/api/terminals'],
    allowedWsTypesBeforeReady: [
      'hello',
      'ready',
      'terminal.create',
      'terminal.created',
      'terminal.output',
      'terminal.list',
      'terminal.meta.list',
      'terminal.meta.list.response',
    ],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'agent-chat-cold-boot',
    description: 'Cold boot into the seeded long-history agent chat session until the surface is visible.',
    focusedReadyMilestone: 'agent_chat.surface_visible',
    allowedApiRouteIdsBeforeReady: ['/api/settings', '/api/sessions', '/api/sessions/:sessionId'],
    allowedWsTypesBeforeReady: ['hello', 'ready', 'sdk.history', 'sessions.updated', 'sessions.patch'],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'sidebar-search-large-corpus',
    description: 'Open the sidebar, search alpha against the seeded corpus, and wait for visible results.',
    focusedReadyMilestone: 'sidebar.search_results_visible',
    allowedApiRouteIdsBeforeReady: ['/api/settings', '/api/sessions', '/api/sessions/search'],
    allowedWsTypesBeforeReady: ['hello', 'ready', 'sessions.updated', 'sessions.patch'],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'terminal-reconnect-backlog',
    description: 'Reconnect to a terminal with a deterministic backlog and wait for visible output recovery.',
    focusedReadyMilestone: 'terminal.first_output',
    allowedApiRouteIdsBeforeReady: ['/api/settings', '/api/terminals'],
    allowedWsTypesBeforeReady: [
      'hello',
      'ready',
      'terminal.attach',
      'terminal.snapshot',
      'terminal.output',
      'terminal.list',
      'terminal.meta.list',
      'terminal.meta.list.response',
    ],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'offscreen-tab-selection',
    description: 'Select a seeded heavy background tab and wait for the newly selected surface to become visible.',
    focusedReadyMilestone: 'tab.selected_surface_visible',
    allowedApiRouteIdsBeforeReady: ['/api/settings'],
    allowedWsTypesBeforeReady: ['hello', 'ready'],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
] as const
