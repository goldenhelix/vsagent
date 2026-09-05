/**
 * Gitea joined the provider vocabulary after these profiles existed, so a saved
 * `visibleTaskProviders` list can never have deliberately excluded it. This mirrors the
 * Jira one-shot backfill (`visibleTaskProvidersDefaultedForJira`) with its own guard flag.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const stores: InstanceType<typeof Store>[] = []

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.flush()
  }
  vi.restoreAllMocks()
})

function dataFileAt(contents: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-gitea-migration-')))
  const file = join(dir, 'orca-data.json')
  writeFileSync(file, JSON.stringify(contents, null, 2), 'utf-8')
  return file
}

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = new Store({ dataFile })
  stores.push(store)
  return store
}

describe('Gitea task-provider visibility migration', () => {
  it('backfills Gitea into a legacy provider list once, then preserves opt-out', () => {
    // A profile written before Gitea had a settings toggle: Jira already
    // migrated, but no Gitea flag — Gitea must be backfilled once.
    const legacyDataFile = dataFileAt({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        visibleTaskProviders: ['github', 'gitlab'],
        visibleTaskProvidersDefaultedForJira: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const backfilled = openStore(legacyDataFile)
    expect(backfilled.getSettings().visibleTaskProviders).toEqual(['github', 'gitlab', 'gitea'])

    // A later profile that deliberately opted out of Gitea keeps it hidden.
    const optedOutDataFile = dataFileAt({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        visibleTaskProviders: ['github', 'gitlab'],
        visibleTaskProvidersDefaultedForJira: true,
        visibleTaskProvidersDefaultedForGitea: true
      },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const optedOut = openStore(optedOutDataFile)
    expect(optedOut.getSettings().visibleTaskProviders).toEqual(['github', 'gitlab'])
  })
})
