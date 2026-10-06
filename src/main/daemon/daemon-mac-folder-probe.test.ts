import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeMacDaemonFolder } from './daemon-mac-folder-probe'
import { setAppEnvironment } from '../../shared/app-environment'
import { MacLaunchdBootstrapError } from './daemon-mac-bootstrap-error'

const m = vi.hoisted(() => ({
  gate: vi.fn(),
  find: vi.fn(),
  managedPath: vi.fn(),
  record: vi.fn(),
  bootstrap: vi.fn(),
  inspect: vi.fn(),
  bootout: vi.fn()
}))
vi.mock('./daemon-mac-host', () => ({
  isPackagedMacDaemonHost: m.gate,
  findOwnedMacDaemonHost: m.find,
  isMacDaemonHostPath: m.managedPath
}))
vi.mock('./daemon-endpoint-incarnation', () => ({ readDaemonPidRecord: m.record }))
vi.mock('./daemon-launch-paths', () => ({ getDaemonRuntimeDir: () => '/profile/daemon' }))
vi.mock('./daemon-spawner', () => ({ getDaemonPidPath: () => '/profile/pid' }))
vi.mock('./daemon-mac-job-retirement', () => ({
  bootoutMacLaunchdJob: m.bootout,
  retireFailedMacLaunchdJob: m.bootout
}))
vi.mock('./daemon-mac-launchd-job', () => ({
  bootstrapMacLaunchdJob: m.bootstrap,
  inspectMacLaunchdJob: m.inspect
}))
let dir: string
const scratch = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  dir = mkdtempSync(join(scratch, 'probe-test-'))
  for (const mock of Object.values(m)) {
    mock.mockReset()
  }
  m.gate.mockReturnValue(true)
  m.record.mockReturnValue({ spawnerExecPath: '/owned/Helper' })
  m.find.mockReturnValue({
    generationDir: dir,
    execPath: '/owned/Helper',
    jobTarget: 'gui/501/daemon'
  })
  m.bootstrap.mockImplementation(async (job) =>
    writeFileSync(join(job.generationDir, 'stdout.log'), '{"outcome":"ok"}\n')
  )
  m.inspect.mockResolvedValue({ status: 'exited', exitCode: 0 })
  m.bootout.mockResolvedValue(true)
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => 'app.asar',
    getVersion: () => '1',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})
describe('fresh folder permission subject', () => {
  it('reuses the daemon bundle for repeated jobs, and never removes its generation', async () => {
    for (let i = 0; i < 2; i++) {
      await expect(
        probeMacDaemonFolder('script', '/Documents/a & b', { ELECTRON_RUN_AS_NODE: '1' })
      ).resolves.toBe('{"outcome":"ok"}\n')
    }
    expect(m.bootstrap.mock.calls[0][1]).toEqual(['-e', 'script', '/Documents/a & b'])
    expect(m.bootstrap.mock.calls[0][0].execPath).toBe('/owned/Helper')
    expect(m.bootstrap.mock.calls[0][0].jobTarget).not.toBe(m.bootstrap.mock.calls[1][0].jobTarget)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'use-lock'))).toBe(false)
  })
  it('uses the original probe for an actual fork or non-packaged host', async () => {
    m.find.mockReturnValue(null)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeUndefined()
    m.gate.mockReturnValue(false)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeUndefined()
    expect(m.bootstrap).not.toHaveBeenCalled()
  })
  it('does not clone or guess a permission subject when the daemon record is unavailable', async () => {
    m.record.mockReturnValue(null)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeNull()
    expect(m.bootstrap).not.toHaveBeenCalled()
  })
  it('returns unknown for a damaged owned-host record instead of probing the installed app', async () => {
    m.find.mockReturnValue(null)
    m.managedPath.mockReturnValue(true)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeNull()
    expect(m.bootstrap).not.toHaveBeenCalled()
  })
  it.each(['not-submitted', 'rejected'] as const)(
    'does not reset before a %s probe job',
    async (disposition) => {
      const beforeRead = vi.fn(async () => true)
      const release = vi.fn()
      m.bootstrap.mockRejectedValue(new MacLaunchdBootstrapError('failed', disposition))
      await expect(
        probeMacDaemonFolder('script', '/Documents', {}, 60_000, {
          host: m.find(),
          release,
          beforeRead
        })
      ).resolves.toBeNull()
      expect(beforeRead).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
    }
  )
  it.each([
    { allowed: true, delayMs: 0 },
    { allowed: false, delayMs: 0 },
    { allowed: true, delayMs: 60_001 }
  ])('holds the folder read until a timely successful reset: %j', async ({ allowed, delayMs }) => {
    vi.useFakeTimers()
    const readFolder = vi.fn()
    let poll: () => void = () => {}
    m.bootstrap.mockImplementation(async (job, args) => {
      runInNewContext(args[1], {
        require: () => ({ readFileSync }),
        process: {
          argv: [process.execPath, ...args.slice(2)],
          exit: () => {
            throw new Error('cancelled')
          }
        },
        readFolder,
        setInterval: (callback: () => void) => {
          poll = callback
          return 1
        },
        clearInterval: () => {}
      })
      poll()
      expect(readFolder).not.toHaveBeenCalled()
      writeFileSync(join(job.generationDir, 'stdout.log'), '{"outcome":"ok"}\n')
    })
    const beforeRead = vi.fn(async () => {
      expect(m.bootstrap).toHaveResolved()
      poll()
      expect(readFolder).not.toHaveBeenCalled()
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return allowed
    })
    m.inspect.mockImplementation(async () => {
      try {
        poll()
        return { status: 'exited', exitCode: 0 }
      } catch {
        return { status: 'exited', exitCode: 1 }
      }
    })
    const release = vi.fn()
    const pending = probeMacDaemonFolder('readFolder()', '/Documents', {}, 60_000, {
      host: m.find(),
      release,
      beforeRead
    })
    if (delayMs >= 60_000) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toBeNull()
      expect(release).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(delayMs - 60_000)
    } else {
      await vi.advanceTimersByTimeAsync(delayMs)
    }
    const result = await pending
    const permitted = allowed && delayMs < 60_000
    expect(beforeRead).toHaveBeenCalledOnce()
    expect(readFolder).toHaveBeenCalledTimes(permitted ? 1 : 0)
    expect(result).toBe(permitted ? '{"outcome":"ok"}\n' : null)
    expect(release).toHaveBeenCalledOnce()
  })
  it('leaves a pending consent read alive after the UI deadline and cleans up when answered', async () => {
    vi.useFakeTimers()
    m.inspect.mockResolvedValue({ status: 'live', pid: 123 })
    const pending = probeMacDaemonFolder('script', '/Documents', {}, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toBeNull()
    expect(m.bootout).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'use-lock'))).toBe(true)
    m.inspect.mockResolvedValue({ status: 'exited', exitCode: 0 })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(m.bootout).toHaveBeenCalledTimes(1)
    expect(existsSync(join(dir, 'use-lock'))).toBe(false)
  })
  it.each(['exit', 'bootstrap', 'output'])('returns unknown on %s failure', async (failure) => {
    if (failure === 'exit') {
      m.inspect.mockResolvedValue({ status: 'exited', exitCode: 1 })
    }
    if (failure === 'bootstrap') {
      m.bootstrap.mockRejectedValue(new Error('launch rejected'))
    }
    if (failure === 'output') {
      m.bootstrap.mockImplementation(async (job) =>
        writeFileSync(join(job.generationDir, 'stdout.log'), 'x'.repeat(1025))
      )
    }
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeNull()
  })
  it('bounds the entire operation, including a wedged bootstrap and retirement', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    m.bootstrap.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    m.bootout.mockResolvedValue(false)
    const pending = probeMacDaemonFolder('script', '/Documents', {})
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toBeNull()
    expect(existsSync(join(dir, 'use-lock'))).toBe(true)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeNull()
    expect(m.bootstrap).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
  })
  it('keeps the bundle pinned until delayed cleanup completes after the caller deadline', async () => {
    vi.useFakeTimers()
    let retire: (value: boolean) => void = () => {}
    m.bootout.mockReturnValue(
      new Promise<boolean>((resolve) => {
        retire = resolve
      })
    )
    const pending = probeMacDaemonFolder('script', '/Documents', {})
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await pending).toBeNull()
    expect(existsSync(join(dir, 'use-lock'))).toBe(true)
    retire(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(existsSync(join(dir, 'use-lock'))).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})
