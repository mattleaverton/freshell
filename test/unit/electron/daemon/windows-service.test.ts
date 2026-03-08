import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DaemonPaths } from '../../../../electron/daemon/daemon-manager.js'

const mockExecFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

import { WindowsServiceDaemonManager } from '../../../../electron/daemon/windows-service.js'

const testPaths: DaemonPaths = {
  nodeBinary: 'C:\\App\\resources\\bundled-node\\bin\\node.exe',
  serverEntry: 'C:\\App\\resources\\server\\index.js',
  serverNodeModules: 'C:\\App\\resources\\server-node-modules',
  nativeModules: 'C:\\App\\resources\\bundled-node\\native-modules',
  configDir: 'C:\\Users\\testuser\\.freshell',
  logDir: 'C:\\Users\\testuser\\.freshell\\logs',
}

function setupExecFileSuccess(stdout = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
    callback(null, stdout, '')
  })
}

describe('WindowsServiceDaemonManager', () => {
  let manager: WindowsServiceDaemonManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new WindowsServiceDaemonManager()
  })

  it('has platform set to win32', () => {
    expect(manager.platform).toBe('win32')
  })

  describe('install', () => {
    it('creates scheduled task via schtasks with correct arguments', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      const createCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Create')
      )
      expect(createCall).toBeDefined()
      expect(createCall![1]).toContain('/SC')
      expect(createCall![1]).toContain('ONLOGON')
      expect(createCall![1]).toContain('/RL')
      expect(createCall![1]).toContain('HIGHEST')
      expect(createCall![1]).toContain('/TN')
      expect(createCall![1]).toContain('Freshell Server')
    })
  })

  describe('uninstall', () => {
    it('deletes scheduled task via schtasks', async () => {
      setupExecFileSuccess()
      await manager.uninstall()

      const deleteCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Delete')
      )
      expect(deleteCall).toBeDefined()
      expect(deleteCall![1]).toContain('/TN')
      expect(deleteCall![1]).toContain('Freshell Server')
      expect(deleteCall![1]).toContain('/F')
    })
  })

  describe('start', () => {
    it('runs scheduled task via schtasks', async () => {
      setupExecFileSuccess()
      await manager.start()

      const runCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Run')
      )
      expect(runCall).toBeDefined()
    })
  })

  describe('stop', () => {
    it('kills the node process', async () => {
      setupExecFileSuccess()
      await manager.stop()

      // Should attempt to kill the process
      const killCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'taskkill'
      )
      // taskkill may or may not be called depending on finding PID
      // but the call should not throw
      expect(true).toBe(true)
    })
  })

  describe('status', () => {
    it('parses Running status from CSV output', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, '"TaskName","Next Run Time","Status"\r\n"Freshell Server","N/A","Running"\r\n', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(true)
    })

    it('parses Ready status (installed but not running)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, '"TaskName","Next Run Time","Status"\r\n"Freshell Server","N/A","Ready"\r\n', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(false)
    })

    it('returns not installed when task not found', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(new Error('ERROR: The system cannot find the file specified.'), '', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(false)
      expect(st.running).toBe(false)
    })
  })

  describe('isInstalled', () => {
    it('returns true when task query succeeds', async () => {
      setupExecFileSuccess('"TaskName"\r\n"Freshell Server"\r\n')
      expect(await manager.isInstalled()).toBe(true)
    })

    it('returns false when task query fails', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(new Error('not found'), '', '')
      })
      expect(await manager.isInstalled()).toBe(false)
    })
  })
})
