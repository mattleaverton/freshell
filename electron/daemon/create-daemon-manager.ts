import type { DaemonManager } from './daemon-manager.js'

export async function createDaemonManager(): Promise<DaemonManager> {
  switch (process.platform) {
    case 'darwin': {
      const { LaunchdDaemonManager } = await import('./launchd.js')
      return new LaunchdDaemonManager()
    }
    case 'linux': {
      const { SystemdDaemonManager } = await import('./systemd.js')
      return new SystemdDaemonManager()
    }
    case 'win32': {
      const { WindowsServiceDaemonManager } = await import('./windows-service.js')
      return new WindowsServiceDaemonManager()
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
