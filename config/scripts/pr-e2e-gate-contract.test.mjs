import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import {
  hasNativeImeSourceChange,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs
} from './pr-e2e-source-routing.mjs'
import {
  EXPECTED_NATIVE_IME_TESTS,
  IME_ENGAGEMENT_RECEIPT_ENV
} from './terminal-ime-engagement-receipt.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const reliabilityManifest = parseJsonc(
  readFileSync(join(projectDir, 'config/reliability-gates.jsonc'), 'utf8')
)
const nativeImeRunner = readFileSync(
  join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
  'utf8'
)
const nativeImeSpec = readFileSync(
  join(projectDir, 'tests/e2e/terminal-ibus-hangul-native.spec.ts'),
  'utf8'
)

/** The route that sends a change to the two-Electron restart-survival spec. */
const restartSurvivalRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'client-hosted-browser.restart-survival'
)

describe('restart-survival E2E routing', () => {
  // Every file below carries behavior the restart spec is the only test that exercises end to end.
  it.each([
    'src/main/runtime/orca-runtime.ts',
    'src/main/runtime/orca-runtime-browser.ts',
    'src/main/runtime/client-hosted-page-reconciliation-window.ts',
    'src/main/runtime/runtime-browser-client-page-adoption.ts',
    'src/main/runtime/runtime-browser-client-page-recovery.ts',
    'src/main/runtime/browser-host-client-page-adoption.ts',
    'src/main/runtime/browser-host-page-reconciliation-orchestration.ts',
    'src/main/runtime/rpc/methods/browser-client-host.ts',
    'src/main/browser/browser-client-host-authority-replacement-wait.ts',
    'src/main/browser/paired-runtime-browser-client-host-composition.ts',
    'src/renderer/src/runtime/web-session-tabs-sync.ts',
    'src/renderer/src/runtime/host-session-snapshot-authority.ts',
    'src/renderer/src/runtime/restored-client-hosted-browser-host-attach.ts',
    'src/renderer/src/store/slices/runtime-status.ts',
    'src/shared/runtime-types.ts',
    'src/shared/browser-client-host-protocol.ts'
  ])('routes %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(true)
  })

  // The pattern is deliberately not "anything under src": routing every PR at a two-Electron spec
  // is the cost the filter exists to avoid.
  it.each([
    'src/main/git/git-status.ts',
    'src/renderer/src/components/tab-bar/BrowserTab.tsx',
    'src/main/terminal/pty-manager.ts',
    // The status/types entries name whole files, not a suffix any longer name may end with.
    'src/shared/computer-use-runtime-types.ts'
  ])('does not route %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(false)
  })
})

describe('PR E2E gate contract', () => {
  it('routes direct-SSH workspace and tab restore from its unnamed source seams', () => {
    // Why by name: none of these carry "ssh", so the SSH authorities above never reach them
    // — a closed-tab tombstone and a dropped default-tabs marker both shipped through it.
    for (const file of [
      'src/renderer/src/hooks/remote-workspace-session-merge.ts',
      'src/main/ipc/remote-workspace-snapshot-normalization.ts',
      'src/renderer/src/lib/worktree-initial-terminal-seeding.ts',
      'src/renderer/src/lib/worktree-default-terminal-tabs.ts',
      'src/shared/remote-workspace-session-projection.ts',
      'src/renderer/src/components/terminal/initial-terminal.ts'
    ]) {
      const specs = selectPrE2eSpecs([file])
      expect(specs, file).toContain('tests/e2e/ssh-cold-activation-restore.spec.ts')
      expect(specs, file).toContain('tests/e2e/ssh-reconnect-tab-destruction.spec.ts')
    }

    expect(
      selectPrE2eSpecs(['src/renderer/src/hooks/remote-workspace-session-merge.test.ts'])
    ).toEqual([])
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/hooks/__tests__/remote-workspace-target-sync-test-harness.ts'
      ])
    ).toEqual([])
  })

  it('routes P0 sentinels from their causal sources', () => {
    const cases = [
      [
        'src/renderer/src/components/tab-bar/TabBarQuickCommandsMenu.tsx',
        'tests/e2e/terminal-quick-command-pre-bind-recovery.spec.ts'
      ],
      ['src/main/runtime/orca-runtime-files.ts', 'tests/e2e/paired-quick-open-large-tree.spec.ts'],
      [
        'src/renderer/src/runtime/sync-runtime-graph.ts',
        'tests/e2e/host-parked-pane-remote-viewer.spec.ts'
      ],
      [
        'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts',
        'tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'
      ],
      [
        'src/renderer/src/components/terminal-pane/remote-pane-layout-push.ts',
        'tests/e2e/paired-remote-pane-layout-retry.spec.ts'
      ]
    ]
    for (const [source, spec] of cases) {
      expect(selectPrE2eSpecs([source]), source).toEqual([spec])
      expect(selectPrE2eSpecs([source.replace(/\.tsx?$/, '.test.ts')]), source).toEqual([])
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
    const parkedSplitSpec = 'tests/e2e/terminal-parked-cli-split.spec.ts'
    for (const source of [
      'src/main/window/attach-main-window-services.ts',
      'src/preload/api/ui-command-event-api.ts',
      'src/preload/index.ts',
      'src/renderer/src/components/terminal-pane/terminal-pane-split-request-routing.ts',
      'src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts',
      'src/renderer/src/components/terminal-pane/use-terminal-tab-cold-parking.ts',
      'src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(parkedSplitSpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        parkedSplitSpec
      )
    }
    expect(existsSync(join(projectDir, parkedSplitSpec)), parkedSplitSpec).toBe(true)

    const restartContinuitySpec = 'tests/e2e/paired-remote-terminal-serve-restart-binding.spec.ts'
    for (const source of [
      'src/main/daemon/daemon-attach-only-retirement.ts',
      'src/main/daemon/daemon-pty-applied-size.ts',
      'src/main/daemon/daemon-pty-session-control.ts',
      'src/main/daemon/daemon-pty-spawn-result.ts',
      'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts',
      'src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts',
      'src/renderer/src/runtime/web-runtime-session.ts',
      'src/renderer/src/runtime/web-session-tabs-sync.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-adoption.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-surface.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-inventory.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-inventory-validation.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-cache.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-pane.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-queue.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-recovery-rpc-lane.ts',
      'src/renderer/src/runtime/web-session-terminal-orphan-topology.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(restartContinuitySpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        restartContinuitySpec
      )
    }
    expect(existsSync(join(projectDir, restartContinuitySpec)), restartContinuitySpec).toBe(true)
    const quickCommandSpec = 'tests/e2e/terminal-quick-command-pre-bind-recovery.spec.ts'
    for (const source of [
      'src/renderer/src/components/terminal-pane/pty-connection.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/connect-pane-pty.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/fresh-spawn-start.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/pane-pty-visibility-bind.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/pty-input-recovery.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(quickCommandSpec)
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).not.toContain(
        quickCommandSpec
      )
    }
    for (const source of [
      'src/main/ipc/rg-availability.ts',
      'src/shared/ripgrep-process-availability.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toEqual([
        'tests/e2e/paired-quick-open-large-tree.spec.ts'
      ])
    }
    expect(
      selectPrE2eSpecs([
        'src/main/runtime/orca-runtime-files.ts',
        'tests/e2e/paired-quick-open-large-tree.spec.ts'
      ])
    ).toEqual(['tests/e2e/paired-quick-open-large-tree.spec.ts'])
    expect(selectPrE2eSpecs(['src/renderer/src/components/FileExplorer.tsx'])).toEqual([])
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts'
      ])
    ).toContain('tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts')
    expect(
      selectPrE2eSpecs([
        'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-test-harness.ts'
      ])
    ).not.toContain('tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts')
    expect(selectPrE2eSpecs(['src/main/ipc/pty.ts'])).not.toContain(
      'tests/e2e/paired-remote-terminal-materialization-reconnect.spec.ts'
    )
  })

  it('triggers the real-IME lane from every surface an input method can judge', () => {
    for (const file of [
      'src/renderer/src/components/terminal-pane/terminal-ime-composition-route.ts',
      'src/renderer/src/components/terminal-pane/terminal-ime-native-text-forwarder.ts',
      'src/renderer/src/components/terminal-pane/terminal-ios-hangul-preedit.ts',
      'src/renderer/src/components/terminal-pane/xterm-bypass-policy.ts',
      'src/renderer/src/lib/pane-manager/terminal-ime-anchor.ts',
      'src/shared/terminal-unicode-provider.ts',
      // The xterm fork owns the helper textarea the IME attaches to; no file here says "ime".
      'config/patches/@xterm__xterm@6.1.0-beta.287.patch',
      'config/patches/xterm-src/browser/Terminal.ts',
      // The harness is source too: breaking the runner or a probe is how the lane goes blind.
      'config/scripts/run-terminal-ibus-hangul-e2e.mjs',
      'config/scripts/terminal-ime-engagement-receipt.mjs',
      'tests/e2e/terminal-ime-boundary-probe.ts',
      'tests/e2e/terminal-ime-byte-reader.ts',
      'tests/e2e/terminal-ime-engagement-receipt.ts',
      'tests/e2e/terminal-ibus-hangul-native.spec.ts'
    ]) {
      expect(hasNativeImeSourceChange([file]), file).toBe(true)
    }

    // Why: a real ibus session on a Git or tab-bar edit is the cost the filter exists to avoid,
    // and a unit test beside the source must not summon a three-and-a-half-minute lane.
    for (const file of [
      'src/main/git/git-status.ts',
      'src/renderer/src/components/tab-bar/BrowserTab.tsx',
      'src/main/terminal/pty-manager.ts',
      'docs/STYLEGUIDE.md',
      'src/renderer/src/components/terminal-pane/terminal-ime-composition-route.test.ts',
      'src/renderer/src/lib/pane-manager/terminal-ime-anchor.test.ts'
    ]) {
      expect(hasNativeImeSourceChange([file]), file).toBe(false)
    }
  })

  it('gives every input-method-gated spec a lane that runs it, or an honest exemption', () => {
    // Why this shape: a spec gated on a native-IME env var that no runner sets is a skip that
    // reports as a pass. This repo already carries such specs; the point is that they are named
    // as gaps rather than counted as coverage.
    const nativeGateExpression = /ORCA_E2E_NATIVE_(?:IBUS_HANGUL|MACOS_KOREAN)\s*[!=]==\s*['"]1['"]/
    const nativeGatedSpecs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `tests/e2e/${file}`)
      .filter((spec) => nativeGateExpression.test(readFileSync(join(projectDir, spec), 'utf8')))
    expect(nativeGatedSpecs.length).toBeGreaterThan(0)

    // Why exempt: the digit repro needs a nested gnome-shell, which no hosted runner provides
    // (headless mutter never answers RemoteDesktop.CreateSession); the macOS spec needs a real
    // macOS input source, and no macOS runner exists on any PR or scheduled lane.
    const unreachableSpecs = new Set([
      'tests/e2e/terminal-hangul-terminating-digit-native.spec.ts',
      'tests/e2e/terminal-macos-2set-korean-native.spec.ts'
    ])
    const unclaimed = nativeGatedSpecs.filter(
      (spec) => !unreachableSpecs.has(spec) && !nativeImeRunner.includes(spec)
    )
    expect(
      unclaimed,
      `Native-IME-gated specs claimed by no lane runner: ${unclaimed.join(', ')}`
    ).toEqual([])

    for (const spec of unreachableSpecs) {
      expect(nativeGatedSpecs, spec).toContain(spec)
      expect(nativeImeRunner.includes(spec), `${spec} is exempt but still invoked`).toBe(false)
    }
  })

  it('requires proof an input method engaged before the lane may report success', () => {
    // Why this is the assertion that matters: every other check in this file protects a job from
    // not running. This one protects a job that ran from having exercised nothing.
    expect(nativeImeRunner).toContain('verifyImeEngagementReceipts')
    expect(nativeImeRunner).toContain(`[IME_ENGAGEMENT_RECEIPT_ENV]: receiptPath`)
    expect(nativeImeSpec).toContain('appendImeEngagementReceipt(testInfo.title, trace)')

    // Why a literal comparison: the spec cannot import the .mjs module, so the env var name is
    // written twice and would otherwise drift into a receipt nobody reads.
    const specSideReceipt = readFileSync(
      join(projectDir, 'tests/e2e/terminal-ime-engagement-receipt.ts'),
      'utf8'
    )
    expect(specSideReceipt).toContain(`'${IME_ENGAGEMENT_RECEIPT_ENV}'`)

    // Why pin the titles: the runner requires one receipt per name, so a rename that nobody
    // mirrored here would fail the lane loudly instead of quietly halving it.
    for (const title of EXPECTED_NATIVE_IME_TESTS) {
      expect(nativeImeSpec, title).toContain(title)
    }
  })

  it('keeps source-routed sentinels registered to their reliability gates', () => {
    const routedGateIds = [
      'terminal-startup.quick-command-pre-bind-recovery',
      'quick-open.paired-host-path-search',
      'terminal-session.host-cold-park-stream-continuity',
      'terminal-provider.ssh-remote-reattach-contract',
      'terminal-session.remote-pane-layout-retry'
    ]
    for (const gateId of routedGateIds) {
      const route = PR_E2E_SOURCE_ROUTES.find((candidate) => candidate.id === gateId)
      const gate = reliabilityManifest.gates.find((candidate) => candidate.id === gateId)
      expect(route, gateId).toBeDefined()
      expect(gate, gateId).toMatchObject({ maturity: 'experimental', protection: 'partial' })
      for (const spec of route.specs) {
        expect(gate.testFiles, gateId).toContain(spec)
        expect(
          gate.commands.some((command) => command.includes(spec)),
          gateId
        ).toBe(true)
      }
    }
  })
})
