import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSshGitProviderMock, getSshGitProviderGenerationMock, gitExecFileAsyncMock } = vi.hoisted(
  () => ({
    getSshGitProviderMock: vi.fn(),
    getSshGitProviderGenerationMock: vi.fn(() => 1),
    gitExecFileAsyncMock: vi.fn()
  })
)

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { _resetGitRemoteNameListingCache, listGitRemoteNames } from './remote-name-listing'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-url-probe'

describe('git remote name listing', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    getSshGitProviderGenerationMock.mockReset()
    getSshGitProviderGenerationMock.mockReturnValue(1)
    gitExecFileAsyncMock.mockReset()
    _resetGitRemoteNameListingCache()
  })

  it('bounds the local listing with the shared probe deadline and caches it', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\ngitea\n\n', stderr: '' })

    await expect(listGitRemoteNames({ repoPath: '/repo' })).resolves.toEqual(['origin', 'gitea'])
    await expect(listGitRemoteNames({ repoPath: '/repo' })).resolves.toEqual(['origin', 'gitea'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
  })

  it('keeps host and WSL listings on separate cache entries', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'gitea\n', stderr: '' })

    await expect(listGitRemoteNames({ repoPath: '/repo' })).resolves.toEqual(['origin'])
    await expect(listGitRemoteNames({ repoPath: '/repo', wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitea'
    ])

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(['remote'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      wslDistro: 'Ubuntu'
    })
  })

  it('never caches a failed listing', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('git died'))
      .mockResolvedValueOnce({ stdout: 'gitea\n', stderr: '' })

    await expect(listGitRemoteNames({ repoPath: '/repo' })).resolves.toEqual([])
    await expect(listGitRemoteNames({ repoPath: '/repo' })).resolves.toEqual(['gitea'])
  })

  it('reads through the SSH provider and never caches a disconnected runtime', async () => {
    const exec = vi.fn(async () => ({ stdout: 'origin\nforgejo\n', stderr: '' }))
    getSshGitProviderMock.mockReturnValueOnce(undefined).mockReturnValue({ exec })

    await expect(
      listGitRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })
    ).resolves.toEqual([])
    await expect(
      listGitRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })
    ).resolves.toEqual(['origin', 'forgejo'])

    const [args, cwd, options] = exec.mock.calls[0] as unknown as [
      string[],
      string,
      { signal?: AbortSignal }
    ]
    expect(args).toEqual(['remote'])
    expect(cwd).toBe('/repo')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('retires a cached listing when the SSH connection generation advances', async () => {
    const exec = vi.fn(async () => ({ stdout: 'gitea\n', stderr: '' }))
    getSshGitProviderMock.mockReturnValue({ exec })

    await listGitRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })
    getSshGitProviderGenerationMock.mockReturnValue(2)
    await listGitRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })

    expect(exec).toHaveBeenCalledTimes(2)
  })
})
