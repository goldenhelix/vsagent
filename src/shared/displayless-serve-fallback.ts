// Why (VSAgent fork): upstream refuses to boot `serve` without a display because Chromium dies in
// Ozone init (#17615), which strands terminal-only deployments that cannot install Xvfb (locked-down
// container images, minimal VPS). Electron does boot display-less on the headless Ozone platform, so
// operators can opt into that trade — terminals work, browser panes do not.
//
// Chromium reads its Ozone platform from the real command line before any JavaScript runs, so the
// switch only takes effect when the process that SPAWNS Electron passes it. Measured on Electron
// 43.4.1 with DISPLAY/WAYLAND_DISPLAY unset: `--ozone-platform=headless` on argv reaches `ready`;
// `app.commandLine.appendSwitch('ozone-platform', 'headless')` is ignored (SIGTRAP, exit 133) and
// `appendSwitch('headless')` SIGSEGVs (exit 139). `--headless` alone on argv also SIGSEGVs. That is
// why this module hands out launch arguments rather than configuring Chromium in-process.

export const DISPLAYLESS_SERVE_FALLBACK_ENV = 'ORCA_ALLOW_DISPLAYLESS_SERVE'
export const HEADLESS_OZONE_PLATFORM = 'headless'
export const DISPLAYLESS_SERVE_OZONE_ARG = `--ozone-platform=${HEADLESS_OZONE_PLATFORM}`

export const DISPLAYLESS_SERVE_ACTIVE_MESSAGE =
  `[serve] Running on the ${HEADLESS_OZONE_PLATFORM} Ozone platform ` +
  `(${DISPLAYLESS_SERVE_FALLBACK_ENV}=1): terminals work, browser panes are off.`

export const DISPLAYLESS_SERVE_OPT_IN_HINT =
  `[serve] Set ${DISPLAYLESS_SERVE_FALLBACK_ENV}=1 and start serve through the orca CLI (or ` +
  `scripts/vsagent-serve) to run without a display anyway (terminals work, browser panes off). ` +
  `A launcher that execs the Electron binary itself must also put ${DISPLAYLESS_SERVE_OZONE_ARG} ` +
  'on the command line — the variable alone cannot move Chromium off its chosen display platform.'

export const DISPLAYLESS_SERVE_LAUNCH_HINT =
  `[serve] ${DISPLAYLESS_SERVE_FALLBACK_ENV}=1 is set, but Chromium already chose a display ` +
  `platform: ${DISPLAYLESS_SERVE_OZONE_ARG} must be on the launch command line. Start serve ` +
  'through the orca CLI, or add that switch to the launcher that runs the Electron binary.'

/** Pure gate read so launchers and startup can test the opt-in without Electron. */
export function isDisplaylessServeFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DISPLAYLESS_SERVE_FALLBACK_ENV]?.trim() === '1'
}

/**
 * Extra Electron argv for a serve launch on a host with no display. Empty unless the operator armed
 * the opt-in; only Linux has an Ozone platform to pick.
 */
export function displaylessServeLaunchArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  return platform === 'linux' && isDisplaylessServeFallbackEnabled(env)
    ? [DISPLAYLESS_SERVE_OZONE_ARG]
    : []
}
