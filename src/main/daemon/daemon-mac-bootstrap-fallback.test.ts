import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'
import { bootoutMacLaunchdJob, retireFailedMacLaunchdJob } from './daemon-mac-job-retirement'
import { MacLaunchdBootstrapError } from './daemon-mac-bootstrap-error'
import { restartDaemon } from './daemon-provider-restart'

const m = vi.hoisted(() => ({
  run: vi.fn(),
  materialize: vi.fn(),
  fork: vi.fn(),
  lease: vi.fn(),
  connect: vi.fn(),
  identity: vi.fn(),
  cleanup: vi.fn(),
  swap: vi.fn(),
  ensureRunning: vi.fn(),
  getHandle: vi.fn(),
  establish: vi.fn(),
  resetHandle: vi.fn(),
  current: { getActiveSessionIds: () => [], fanoutSyntheticExits: vi.fn() }
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: m.run }))
vi.mock('./daemon-mac-host', () => ({ materializeMacDaemonHost: m.materialize }))
vi.mock('./daemon-mac-launch-environment', () => ({
  prepareMacDaemonEnvironment: () => ({ args: [], env: {}, dispose() {} })
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonEntryPath: () => '/installed/entry.js',
  daemonLogArgs: () => [],
  getDaemonRuntimeDir: () => '/runtime',
  getDaemonHistoryDir: () => '/history',
  resolvePackagedDarwinAppVersion: () => '1',
  probeDaemonSocket: async () => false
}))
vi.mock('./daemon-host-relocation', () => ({ materializeRelocatedDaemonHost: () => null }))
vi.mock('./daemon-replacement-preflight', () => ({ prepareDaemonReplacement: async () => null }))
vi.mock('./daemon-launched-child', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  launchDaemonChild: m.fork
}))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = m.connect
    getDaemonIdentity = m.identity
    disconnect() {}
  }
}))
vi.mock('./daemon-endpoint-adoption', () => ({
  holdDaemonAdoptionLease: m.lease,
  reconcileDaemonPidOwnership: vi.fn(),
  releaseDaemonAdoptionLease: vi.fn(),
  takeDaemonAdoptionLeaseRelease: vi.fn()
}))
vi.mock('./daemon-provider-state', () => ({
  getDaemonSpawner: () => ({
    ensureRunning: m.ensureRunning,
    resetHandle: m.resetHandle,
    resetRespawnWindow() {},
    getHandle: m.getHandle
  }),
  getDaemonProvider: () => m.current,
  replaceDaemonProvider: m.swap
}))
vi.mock('./daemon-provider-routing', () => ({
  getCurrentDaemonAdapter: () => m.current,
  getLegacyDaemonAdapters: () => [],
  disposeProviderSubscriptionsOnly: vi.fn()
}))
vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class {
    establishLifecycleLease = m.establish
  }
}))
vi.mock('./daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: m.cleanup }))
vi.mock('./daemon-adoption-failure-cleanup', () => ({ cleanupFailedDaemonAdoption: vi.fn() }))
vi.mock('../ipc/pty', () => ({
  unbindLocalProviderListeners: vi.fn(),
  rebindLocalProviderListeners: vi.fn()
}))
vi.mock('./daemon-history', () => ({ getHistoryDir: () => '/history' }))
vi.mock('./daemon-lifecycle-event', () => ({ trackDaemonRetired: vi.fn() }))

let dir: string
let host: { generationDir: string; execPath: string; entryPath: string; jobTarget: string }
const scratch = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  dir = mkdtempSync(join(scratch, 'bootstrap-fallback-test-'))
  host = {
    generationDir: join(dir, 'generation'),
    execPath: join(dir, 'generation', 'Helper'),
    entryPath: join(dir, 'generation', 'entry.js'),
    jobTarget: 'gui/501/com.stablyai.orca.terminal.rejected-test'
  }
  mkdirSync(host.generationDir)
  for (const [key, mock] of Object.entries(m)) {
    if (key !== 'current' && 'mockReset' in mock) {
      mock.mockReset()
    }
  }
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => 'app.asar',
    getVersion: () => '1',
    isPackaged: () => true,
    onWillQuit() {},
    exit() {},
    getAppMetrics: () => []
  })
  m.materialize.mockResolvedValue(host)
  m.run.mockImplementation(async (spec) => {
    if (spec.args[0] === 'bootstrap') {
      return {
        code: 5,
        stdout: '',
        stderr: 'Bootstrap failed: 5: Input/output error',
        timedOut: false
      }
    }
    return {
      code: 113,
      stdout: '',
      stderr:
        'Bad request.\nCould not find service "com.stablyai.orca.terminal.rejected-test" in domain for user gui: 501\n',
      timedOut: false
    }
  })
  m.connect.mockRejectedValue(new Error('no endpoint'))
  m.lease.mockImplementation(async (handle) => handle)
  m.fork.mockResolvedValue({
    child: { pid: 44 },
    identity: { pid: 44, startedAtMs: 1, launchNonce: 'fork' }
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('verified rejected bootstrap uses the persistent launcher', () => {
  it('cold start sees real retirement refuse the missing job, then forks and reclaims the never-run clone', async () => {
    expect(await bootoutMacLaunchdJob(host)).toBe(false)
    const handle = await createOutOfProcessLauncher(dir)('/socket', '/token', '/pid', 'cold')
    expect(m.fork).toHaveBeenCalledOnce()
    expect(handle.mode).toBeUndefined()
    expect(existsSync(host.generationDir)).toBe(false)
    expect(m.run.mock.calls.some(([spec]) => ['kill', 'bootout'].includes(spec.args[0]))).toBe(
      false
    )
  })
  it('provider restart installs the persistent fork after retiring the old daemon', async () => {
    m.ensureRunning.mockImplementation(async () => {
      const handle = await createOutOfProcessLauncher(dir)('/socket', '/token', '/pid', 'restart')
      m.getHandle.mockReturnValue(handle)
      return { socketPath: '/socket', tokenPath: '/token' }
    })
    await expect(restartDaemon()).resolves.toEqual({ killedCount: 0 })
    expect(m.cleanup).toHaveBeenCalledOnce()
    expect(m.fork).toHaveBeenCalledOnce()
    expect(m.establish).toHaveBeenCalledOnce()
    expect(m.swap).toHaveBeenCalledOnce()
    expect(existsSync(host.generationDir)).toBe(false)
  })
  it('adopts the occupied endpoint normally even when a successfully submitted loser is now missing', async () => {
    m.run.mockImplementation(async (spec) =>
      spec.args[0] === 'bootstrap'
        ? { code: 0, stdout: '', stderr: '', timedOut: false }
        : {
            code: 113,
            stdout: '',
            stderr:
              'Could not find service "com.stablyai.orca.terminal.rejected-test" in domain for user gui: 501',
            timedOut: false
          }
    )
    m.connect.mockResolvedValueOnce(undefined).mockResolvedValue(undefined)
    m.identity.mockReturnValue({ pid: 55, startedAtMs: 1, launchNonce: 'winner' })
    const handle = await createOutOfProcessLauncher(dir)('/socket', '/token', '/pid', 'loser')
    expect(handle.adopted).toBe(true)
    expect(handle.mode).toBeUndefined()
    expect(m.fork).not.toHaveBeenCalled()
    expect(existsSync(host.generationDir)).toBe(true)
  })
  it('does not turn service absence after an uncertain bootstrap into process exit', async () => {
    expect(
      await retireFailedMacLaunchdJob(host, new MacLaunchdBootstrapError('timeout', 'unverifiable'))
    ).toBe(false)
    expect(existsSync(host.generationDir)).toBe(true)
  })
})
