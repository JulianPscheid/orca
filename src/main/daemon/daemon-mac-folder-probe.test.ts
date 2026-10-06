import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeMacDaemonFolder } from './daemon-mac-folder-probe'

const m = vi.hoisted(() => ({
  gate: vi.fn(),
  materialize: vi.fn(),
  strategy: vi.fn(),
  bootstrap: vi.fn(),
  inspect: vi.fn(),
  bootout: vi.fn()
}))
vi.mock('./daemon-mac-host', () => ({
  isPackagedMacDaemonHost: m.gate,
  materializeMacDaemonHost: m.materialize
}))
vi.mock('./daemon-mac-launch', () => ({ getMacDaemonLaunchStrategy: m.strategy }))
vi.mock('./daemon-mac-launchd-job', () => ({
  bootstrapMacLaunchdJob: m.bootstrap,
  inspectMacLaunchdJob: m.inspect,
  bootoutMacLaunchdJob: m.bootout
}))
vi.mock('./daemon-launch-paths', () => ({ getDaemonEntryPath: () => '/installed/entry' }))
let dir: string
const scratch = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  dir = mkdtempSync(join(scratch, 'probe-test-'))
  for (const mock of Object.values(m)) {
    mock.mockReset()
  }
  m.gate.mockReturnValue(true)
  m.materialize.mockResolvedValue({
    generationDir: dir,
    execPath: '/owned/Helper',
    jobTarget: 'gui/501/probe'
  })
  m.strategy.mockReturnValue(null)
  m.inspect.mockResolvedValue({ status: 'exited', exitCode: 0 })
  m.bootout.mockResolvedValue(true)
  writeFileSync(join(dir, 'stdout.log'), '{"outcome":"ok"}\n')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})
describe('fresh folder permission subject', () => {
  it('uses a one-shot job from the clone, returning the measured result only after exit', async () => {
    await expect(
      probeMacDaemonFolder('script', '/Documents/a & b', { ELECTRON_RUN_AS_NODE: '1' })
    ).resolves.toBe('{"outcome":"ok"}\n')
    expect(m.bootstrap.mock.calls[0][1]).toEqual(['-e', 'script', '/Documents/a & b'])
    expect(m.bootout).toHaveBeenCalledTimes(1)
  })
  it('uses the original probe when the actual daemon fell back to a fork', async () => {
    m.strategy.mockReturnValue('fork')
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeUndefined()
    expect(m.materialize).not.toHaveBeenCalled()
  })
  it('uses the original probe off packaged Darwin and on clone failure', async () => {
    m.gate.mockReturnValue(false)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeUndefined()
    m.gate.mockReturnValue(true)
    m.materialize.mockResolvedValue(null)
    await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeUndefined()
  })
  it.each(['exit', 'bootstrap', 'output'])(
    'returns unknown, never denial, on %s failure',
    async (failure) => {
      if (failure === 'exit') {
        m.inspect.mockResolvedValue({ status: 'exited', exitCode: 1 })
      }
      if (failure === 'bootstrap') {
        m.bootstrap.mockRejectedValue(new Error('launch rejected'))
      }
      if (failure === 'output') {
        writeFileSync(join(dir, 'stdout.log'), 'x'.repeat(1025))
      }
      await expect(probeMacDaemonFolder('script', '/Documents', {})).resolves.toBeNull()
    }
  )
  it('retains a host with unverifiable lifetime evidence through a bounded timeout', async () => {
    vi.useFakeTimers()
    m.inspect.mockResolvedValue({ status: 'unverifiable' })
    const pending = probeMacDaemonFolder('script', '/Documents', {})
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(pending).resolves.toBeNull()
    expect(m.bootout).toHaveBeenCalledTimes(1)
    expect(existsSync(dir)).toBe(true)
  })
})
