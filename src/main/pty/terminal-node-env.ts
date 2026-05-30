export function removeInheritedNodeEnv(env: Record<string, string>): void {
  // Why: Orca's own process may run with NODE_ENV set (e.g. a deployed server
  // started by systemd with NODE_ENV=production). A terminal emulator should
  // not propagate that app-process choice into user shells — it silently
  // changes tooling behavior (npm install skips devDependencies, build tools
  // switch to production mode). If the user's login shell exports NODE_ENV,
  // their startup files still set it after spawn. Mirrors removeInheritedNoColor.
  delete env.NODE_ENV
}
