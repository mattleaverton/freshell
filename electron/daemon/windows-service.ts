import { execFile } from 'child_process'
import type { DaemonManager, DaemonPaths, DaemonStatus } from './daemon-manager.js'

const TASK_NAME = 'Freshell Server'

function execFilePromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string })
      }
    })
  })
}

export class WindowsServiceDaemonManager implements DaemonManager {
  readonly platform = 'win32' as const
  private nodeBinaryPath?: string

  async install(paths: DaemonPaths, port: number): Promise<void> {
    this.nodeBinaryPath = paths.nodeBinary

    const nodePath = [paths.nativeModules, paths.serverNodeModules].join(';')

    // Use schtasks /Create to create a scheduled task
    await execFilePromise('schtasks', [
      '/Create',
      '/TN', TASK_NAME,
      '/TR', `"${paths.nodeBinary}" "${paths.serverEntry}"`,
      '/SC', 'ONLOGON',
      '/RL', 'HIGHEST',
      '/F', // Force overwrite if exists (idempotent)
    ])
  }

  async uninstall(): Promise<void> {
    try {
      await execFilePromise('schtasks', [
        '/Delete',
        '/TN', TASK_NAME,
        '/F',
      ])
    } catch {
      // Ignore if not found
    }
  }

  async start(): Promise<void> {
    await execFilePromise('schtasks', ['/Run', '/TN', TASK_NAME])
  }

  async stop(): Promise<void> {
    try {
      // Try to kill the node process by task name
      await execFilePromise('taskkill', ['/IM', 'node.exe', '/F'])
    } catch {
      // Ignore if process not found
    }
  }

  async status(): Promise<DaemonStatus> {
    try {
      const { stdout } = await execFilePromise('schtasks', [
        '/Query',
        '/TN', TASK_NAME,
        '/FO', 'CSV',
      ])

      const lines = stdout.split('\r\n').filter(Boolean)
      if (lines.length < 2) {
        return { installed: false, running: false }
      }

      const dataLine = lines[1]
      const running = dataLine.includes('"Running"')

      return {
        installed: true,
        running,
      }
    } catch {
      return {
        installed: false,
        running: false,
      }
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      await execFilePromise('schtasks', ['/Query', '/TN', TASK_NAME])
      return true
    } catch {
      return false
    }
  }
}
