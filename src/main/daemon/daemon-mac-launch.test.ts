import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launchMacDaemon, getMacDaemonLaunchStrategy } from './daemon-mac-launch'
import { DaemonEndpointUnavailableError } from './daemon-launched-child'
import type { DaemonChildSpawnOptions } from './daemon-launched-child-spawn'

const m = vi.hoisted(() => ({
  materialize: vi.fn(),
  bootstrap: vi.fn(),
  inspect: vi.fn(),
  bootout: vi.fn(),
  terminate: vi.fn(),
  connect: vi.fn(),
  identity: vi.fn(),
  disconnect: vi.fn(),
  lease: vi.fn()
}))
vi.mock('./daemon-mac-host', () => ({ materializeMacDaemonHost: m.materialize }))
vi.mock('./daemon-mac-launchd-job', () => ({
  bootstrapMacLaunchdJob: m.bootstrap,
  inspectMacLaunchdJob: m.inspect,
  bootoutMacLaunchdJob: m.bootout,
  terminateMacLaunchdJob: m.terminate,
  macLaunchdStartupError: () => 'startup diagnostic'
}))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = m.connect
    getDaemonIdentity = m.identity
    disconnect = m.disconnect
  }
}))
vi.mock('./daemon-endpoint-adoption', () => ({ holdDaemonAdoptionLease: m.lease }))

const host = {
  generationDir: '/owned/generation',
  execPath: '/owned/Orca Helper',
  entryPath: '/owned/daemon-entry.js',
  jobTarget: 'gui/501/owned'
}
const options: DaemonChildSpawnOptions = {
  entryPath: '/install/entry.js',
  forkEntryPath: '/install/entry.js',
  userDataPath: '/profile',
  socketPath: '/profile/socket',
  tokenPath: '/profile/token',
  pidPath: '/profile/pid',
  launchNonce: 'attempt-1',
  macosLoginSessionWatch: true
}
const identity = { pid: 42, startedAtMs: 123, launchNonce: 'attempt-1' }
beforeEach(() => {
  vi.useRealTimers()
  for (const mock of Object.values(m)) {
    mock.mockReset()
  }
  m.materialize.mockResolvedValue(host)
  m.bootstrap.mockResolvedValue(undefined)
  m.inspect.mockResolvedValue({ status: 'live', pid: 42 })
  m.connect.mockResolvedValue(undefined)
  m.identity.mockReturnValue(identity)
  m.bootout.mockResolvedValue(true)
  m.lease.mockImplementation(async (handle) => handle)
})
describe('authenticated launchd daemon readiness', () => {
  it('runs both paths from the clone, records stable responsibility, and transfers the connected lease', async () => {
    const handle = await launchMacDaemon(options)
    expect(handle).not.toBeNull()
    expect(m.bootstrap.mock.calls[0][1][0]).toBe(host.entryPath)
    const args = m.bootstrap.mock.calls[0][1]
    expect(args[args.indexOf('--entry-path') + 1]).toBe(options.entryPath)
    expect(args[args.indexOf('--spawner-exec-path') + 1]).toBe(host.execPath)
    expect(m.bootstrap.mock.calls[0][3].ELECTRON_RUN_AS_NODE).toBe('1')
    expect(m.lease.mock.calls[0][3]).toBeDefined()
    expect(m.lease.mock.calls[0][4]).toEqual(identity)
    expect(m.disconnect).not.toHaveBeenCalled()
    expect(m.bootout).not.toHaveBeenCalled()
    expect(getMacDaemonLaunchStrategy()).toBe('launchd')
    await handle?.shutdown()
    expect(m.terminate).toHaveBeenCalledWith(host)
  })
  it('a nonce mismatch loses the endpoint race, cleans up only its own job, and lets the caller adopt', async () => {
    m.identity.mockReturnValue({ ...identity, launchNonce: 'winner' })
    await expect(launchMacDaemon(options)).rejects.toBeInstanceOf(DaemonEndpointUnavailableError)
    expect(m.bootout).toHaveBeenCalledExactlyOnceWith(host)
    expect(m.lease).not.toHaveBeenCalled()
  })
  it('keeps the authenticated pair alive while launchd inspection is temporarily unverifiable', async () => {
    m.inspect.mockResolvedValueOnce({ status: 'unverifiable' })
    await expect(launchMacDaemon(options)).resolves.not.toBeNull()
    expect(m.connect).toHaveBeenCalledTimes(2)
    expect(m.disconnect).not.toHaveBeenCalled()
    expect(m.lease).toHaveBeenCalledTimes(1)
  })
  it('maps launchd endpoint-occupied exit to adoption without retrying', async () => {
    m.connect.mockRejectedValue(new Error('no endpoint'))
    m.inspect.mockResolvedValue({ status: 'exited', exitCode: 73 })
    // The daemon's reserved endpoint exit code is used, independent of parent-child IPC.
    const { DAEMON_EXIT_ENDPOINT_OCCUPIED } = await import('./daemon-endpoint-ownership')
    m.inspect.mockResolvedValue({ status: 'exited', exitCode: DAEMON_EXIT_ENDPOINT_OCCUPIED })
    await expect(launchMacDaemon(options)).rejects.toBeInstanceOf(DaemonEndpointUnavailableError)
  })
  it.each(['assessment', 'bootstrap'])(
    'fails open on %s failure and records the actual fork strategy',
    async (failure) => {
      if (failure === 'bootstrap') {
        m.bootstrap.mockRejectedValue(new Error('bootstrap rejected'))
      } else {
        m.connect.mockRejectedValue(new Error('no endpoint'))
        m.inspect.mockResolvedValue({ status: 'exited', exitCode: 1 })
      }
      await expect(launchMacDaemon(options)).resolves.toBeNull()
      expect(m.bootout).toHaveBeenCalledExactlyOnceWith(host)
      expect(getMacDaemonLaunchStrategy()).toBe('fork')
    }
  )
  it('materialization failure never reports a protected launch', async () => {
    m.materialize.mockResolvedValue(null)
    await expect(launchMacDaemon(options)).resolves.toBeNull()
    expect(m.bootstrap).not.toHaveBeenCalled()
    expect(getMacDaemonLaunchStrategy()).toBe('fork')
  })
  it('bounds nonce-free or unverifiable readiness and leaves uncertain cleanup pinned', async () => {
    vi.useFakeTimers()
    m.identity.mockReturnValue(null)
    m.inspect.mockResolvedValue({ status: 'unverifiable' })
    m.bootout.mockResolvedValue(false)
    const pending = launchMacDaemon(options)
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(pending).resolves.toBeNull()
    expect(m.lease).not.toHaveBeenCalled()
    expect(m.bootout).toHaveBeenCalledExactlyOnceWith(host)
    vi.useRealTimers()
  })
  it('does not accept a reused or unrelated PID under the owned job', async () => {
    vi.useFakeTimers()
    m.inspect.mockResolvedValue({ status: 'live', pid: 43 })
    const pending = launchMacDaemon(options)
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(pending).resolves.toBeNull()
    expect(m.lease).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
