import { beforeEach, describe, expect, it, vi } from 'vitest'
const { mockLogger } = vi.hoisted(() => ({ mockLogger: { warn: vi.fn() } }))
vi.mock('../../../server/logger.js', () => ({ logger: mockLogger }))
import { chunkProjects } from '../../../server/ws-chunking.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

describe('WebSocket chunking', () => {
  describe('chunkProjects', () => {
    beforeEach(() => {
      mockLogger.warn.mockClear()
    })

    const createProject = (path: string, sessionCount: number): ProjectGroup => ({
      projectPath: path,
      sessions: Array.from({ length: sessionCount }, (_, i) => ({
        sessionId: `session-${i}`,
        projectPath: path,
        updatedAt: Date.now(),
      })),
    })

    it('returns single chunk for small data', () => {
      const projects = [createProject('/project/one', 2)]
      const chunks = chunkProjects(projects, 500 * 1024) // 500KB limit
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toEqual(projects)
    })

    it('returns empty array in single chunk for empty input', () => {
      const chunks = chunkProjects([], 500 * 1024)
      expect(chunks.length).toBe(1)
      expect(chunks[0]).toEqual([])
    })

    it('splits large data into multiple chunks', () => {
      // Create projects that will exceed the chunk size
      const projects = Array.from({ length: 100 }, (_, i) =>
        createProject(`/project/${i}`, 50) // Each project with 50 sessions
      )

      const smallChunkSize = 10 * 1024 // 10KB to force chunking
      const chunks = chunkProjects(projects, smallChunkSize)

      expect(chunks.length).toBeGreaterThan(1)

      // Verify all sessions are included across chunks (projects may be split)
      const allEntries = chunks.flat()
      const totalSessions = allEntries.reduce((sum, p) => sum + p.sessions.length, 0)
      const originalSessions = projects.reduce((sum, p) => sum + p.sessions.length, 0)
      expect(totalSessions).toBe(originalSessions)

      // Verify all project paths are represented
      const uniquePaths = new Set(allEntries.map(p => p.projectPath))
      expect(uniquePaths.size).toBe(projects.length)
    })

    it('keeps each chunk under the size limit', () => {
      const projects = Array.from({ length: 50 }, (_, i) =>
        createProject(`/project/${i}`, 20)
      )

      const maxBytes = 5000 // 5KB limit
      const chunks = chunkProjects(projects, maxBytes)

      for (const chunk of chunks) {
        const chunkSize = Buffer.byteLength(JSON.stringify({ type: 'sessions.updated', projects: chunk }))
        // Allow some overhead for the message wrapper
        expect(chunkSize).toBeLessThan(maxBytes + 200)
      }
    })

    it('splits a single oversized project into multiple chunks', () => {
      const largeProject = createProject('/large/project', 1000) // Many sessions
      const smallChunkSize = 5000 // Small enough to force splitting

      const chunks = chunkProjects([largeProject], smallChunkSize)

      // Should be split across multiple chunks
      expect(chunks.length).toBeGreaterThan(1)

      // All sub-groups should have the same projectPath
      for (const chunk of chunks) {
        expect(chunk.length).toBe(1)
        expect(chunk[0].projectPath).toBe('/large/project')
      }

      // All sessions should be preserved across sub-groups
      const allSessions = chunks.flatMap(c => c[0].sessions)
      expect(allSessions.length).toBe(1000)
      expect(allSessions.map(s => s.sessionId)).toEqual(
        largeProject.sessions.map(s => s.sessionId)
      )
    })

    it('preserves session order when splitting one project across chunks', () => {
      const project: ProjectGroup = {
        projectPath: '/ordered/project',
        sessions: Array.from({ length: 12 }, (_, index) => ({
          sessionId: `session-${index}`,
          projectPath: '/ordered/project',
          updatedAt: 1000 - index,
          summary: 'x'.repeat(150),
        })),
      }

      const chunks = chunkProjects([project], 900)

      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.flatMap((chunk) => chunk[0].sessions.map((session) => session.sessionId))).toEqual(
        project.sessions.map((session) => session.sessionId),
      )
    })

    it('keeps oversized project with single session in one chunk', () => {
      // A project with just one session can't be split further
      const singleSessionProject = createProject('/big/session', 1)
      const tinyChunkSize = 10 // Smaller than any possible project

      const chunks = chunkProjects([singleSessionProject], tinyChunkSize)

      expect(chunks.length).toBe(1)
      expect(chunks[0][0]).toEqual(singleSessionProject)
    })

    it('preserves color when splitting oversized projects', () => {
      const project: ProjectGroup = {
        ...createProject('/colored/project', 100),
        color: '#ff0000',
      }
      const smallChunkSize = 2000

      const chunks = chunkProjects([project], smallChunkSize)
      expect(chunks.length).toBeGreaterThan(1)

      for (const chunk of chunks) {
        expect(chunk[0].color).toBe('#ff0000')
      }
    })

    it('warns and isolates an individually oversized session inside a multi-session project', () => {
      const project: ProjectGroup = {
        projectPath: '/mixed/project',
        sessions: [
          {
            sessionId: 'huge',
            projectPath: '/mixed/project',
            updatedAt: Date.now(),
            summary: 'x'.repeat(6000),
          },
          {
            sessionId: 'small',
            projectPath: '/mixed/project',
            updatedAt: Date.now(),
          },
        ] as any,
      }

      const chunks = chunkProjects([project], 1000)

      expect(chunks).toHaveLength(2)
      expect(chunks[0][0].sessions.map((s) => s.sessionId)).toEqual(['huge'])
      expect(chunks[1][0].sessions.map((s) => s.sessionId)).toEqual(['small'])
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'oversized_unsplittable_project',
          projectPath: '/mixed/project',
          sessionCount: 1,
        }),
        expect.any(String),
      )
    })

    it('preserves project order', () => {
      const projects = Array.from({ length: 10 }, (_, i) =>
        createProject(`/project/${i}`, 5)
      )

      const chunks = chunkProjects(projects, 1000)
      const allProjects = chunks.flat()

      for (let i = 0; i < projects.length; i++) {
        expect(allProjects[i].projectPath).toBe(projects[i].projectPath)
      }
    })

    it('handles non-ASCII characters correctly', () => {
      // Test that byte length (not UTF-16 code units) is used
      const projectWithUnicode: ProjectGroup = {
        projectPath: '/项目/测试', // Chinese characters
        sessions: [{
          sessionId: 'émoji-🎉-session',
          projectPath: '/项目/测试',
          updatedAt: Date.now(),
        }],
      }

      // Small limit that would pass with UTF-16 length but fail with byte length
      const chunks = chunkProjects([projectWithUnicode], 500)

      // Should still work (put in single chunk since can't split)
      expect(chunks.length).toBe(1)
      expect(chunks[0][0]).toEqual(projectWithUnicode)
    })
  })

})
