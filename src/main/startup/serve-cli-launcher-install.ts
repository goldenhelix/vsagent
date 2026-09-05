import { app } from 'electron'
import { CliInstaller } from '../cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'

/**
 * Serve-time CLI launcher installs. Headless serve has no renderer to run the normal `cli:install`
 * flow, so the launchers are linked here — unless a tarball install already owns them.
 */
export async function installServeCliLaunchers(): Promise<void> {
  // Why (VSAgent fork): a tarball install links the CLI launchers itself, so the serve process must
  // neither race nor overwrite them. Gates both install blocks below.
  const cliLaunchersExternallyManaged = process.env.ORCA_MANAGED_INSTALL === '1'
  // Why macOS/Linux only: install() on Windows only mutates registry PATH, not child terminals.
  if (
    !cliLaunchersExternallyManaged &&
    (process.platform === 'darwin' || process.platform === 'linux')
  ) {
    try {
      // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
      const cliStatus = await new CliInstaller({
        privilegedRunner: async () => {
          throw new Error('serve CLI auto-install must not request administrator privileges')
        }
      }).install()
      console.log(
        `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] orca CLI install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
  if (
    !cliLaunchersExternallyManaged &&
    process.platform === 'linux' &&
    app.isPackaged &&
    process.resourcesPath
  ) {
    try {
      const dispatcher = await installLinuxBareOrcaDispatcher({
        resourcesPath: process.resourcesPath
      })
      console.log(
        `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
          `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] bare orca dispatcher install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
