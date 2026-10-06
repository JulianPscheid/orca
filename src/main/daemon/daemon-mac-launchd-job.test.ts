import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { MAC_DAEMON_HOST_RECORD, type MacDaemonHost } from './daemon-mac-host'
import {
  bootstrapMacLaunchdJob,
  buildMacLaunchdPlist,
  classifyMacLaunchdJob,
  inspectMacLaunchdJob
} from './daemon-mac-launchd-job'

import { pruneMacDaemonHosts } from './daemon-mac-host-prune'
import { bootoutMacLaunchdJob, terminateMacLaunchdJob } from './daemon-mac-job-retirement'
import { lockMacDaemonHost } from './daemon-mac-host-lock'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))
let profile: string
let host: MacDaemonHost
const platform = process.platform
const scratch = join(platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
const generation = '11111111-1111-4111-8111-111111111111'
function output(state: string): string {
  return `${host.jobTarget} = {\n\tprogram = ${host.execPath}\n${state}\n}`
}
beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  profile = realpathSync(mkdtempSync(join(scratch, 'job-test-')))
  const generationDir = join(profile, 'daemon-host-mac', generation)
  host = {
    generationDir,
    execPath: join(generationDir, 'Orca.app', 'Helper'),
    entryPath: join(generationDir, 'Orca.app', 'entry.js'),
    jobTarget: `gui/${process.getuid?.()}/com.stablyai.orca.terminal.${generation}`
  }
  mkdirSync(generationDir, { recursive: true })
  writeFileSync(join(generationDir, MAC_DAEMON_HOST_RECORD), JSON.stringify(host))
  setAppEnvironment({
    getPath: () => profile,
    getAppPath: () => 'app.asar',
    getVersion: () => '1',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  run.mockReset()
  run.mockResolvedValue({
    code: 0,
    stdout: output('state = not running\nlast exit code = 0'),
    stderr: '',
    timedOut: false
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  rmSync(profile, { recursive: true, force: true })
})
describe('launchd lifetime reservation', () => {
  it('runs once in the GUI domain without a login item or respawn demand', async () => {
    const plist = buildMacLaunchdPlist(host, ['a < b & "x"', '$HOME'], profile, {
      ELECTRON_RUN_AS_NODE: '1'
    })
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>KeepAlive</key><false/>')
    expect(plist).toContain('<key>AbandonProcessGroup</key><true/>')
    expect(plist).toContain('a &lt; b &amp; &quot;x&quot;')
    expect(plist).toContain('$HOME')
    await bootstrapMacLaunchdJob(host, [], profile, {})
    expect(run.mock.calls[0][0].args[0]).toBe('bootstrap')
    expect(run.mock.calls[0][0].args[1]).toBe(`gui/${process.getuid?.()}`)
  })
  it.each([
    'state = waiting',
    'state = not running',
    'state = running\npid = 42',
    'state = not running\nlast exit code = 0\npid = 42'
  ])('retains host for incomplete assessment or live job: %s', async (state) => {
    run.mockResolvedValue({ code: 0, stdout: output(state), timedOut: false })
    await pruneMacDaemonHosts()
    expect(existsSync(host.generationDir)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it.each([
    { code: 3, stdout: '' },
    { code: 0, stdout: 'corrupt' },
    { code: 0, timedOut: true },
    { code: 0, outputTruncated: true }
  ])('retains on unverifiable launchd evidence %j', async (overrides) => {
    run.mockResolvedValue({
      stdout: output('state = not running\nlast exit code = 0'),
      timedOut: false,
      ...overrides
    })
    await pruneMacDaemonHosts()
    expect(existsSync(host.generationDir)).toBe(true)
  })
  it('positive exit plus successful bootout is the only reclaim path', async () => {
    // PID records, legacy protocols, and other profiles cannot remove this prelaunch pin.
    writeFileSync(join(profile, 'daemon-v1.pid'), 'corrupt')
    await Promise.all([pruneMacDaemonHosts(), pruneMacDaemonHosts()])
    expect(existsSync(host.generationDir)).toBe(false)
    expect(run.mock.calls.every(([spec]) => spec.args[1] === host.jobTarget)).toBe(true)
  })
  it('recognizes captured signal-exit evidence without treating a still-present PID as exited', async () => {
    const state = 'state = not running\nlast terminating signal = Killed: 9'
    expect(classifyMacLaunchdJob(output(state), host)).toEqual({ status: 'exited', exitSignal: 9 })
    expect(classifyMacLaunchdJob(output(`${state}\npid = 42`), host).status).toBe('live')
    run.mockResolvedValue({ code: 0, stdout: output(state), timedOut: false })
    await pruneMacDaemonHosts()
    expect(existsSync(host.generationDir)).toBe(false)
  })
  it('shutdown signals only its live job and retains positive exit evidence for pruning', async () => {
    run.mockResolvedValueOnce({ code: 0, stdout: output('state = running\npid = 42') })
    await terminateMacLaunchdJob(host)
    expect(run.mock.calls[1][0].args).toEqual(['kill', 'SIGTERM', host.jobTarget])
    expect(run.mock.calls.some(([spec]) => spec.args[0] === 'bootout')).toBe(false)
    expect(existsSync(host.generationDir)).toBe(true)
  })
  it('uncertain shutdown never sends a signal', async () => {
    run.mockResolvedValue({ code: 3, stdout: '' })
    await expect(terminateMacLaunchdJob(host)).rejects.toThrow('Cannot verify')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('does not delete after a failed bootout or corrupt reservation', async () => {
    run.mockImplementation(async (spec) =>
      spec.args[0] === 'bootout'
        ? { code: 1 }
        : { code: 0, stdout: output('state = not running\nlast exit code = 1') }
    )
    await pruneMacDaemonHosts()
    expect(existsSync(host.generationDir)).toBe(true)
    writeFileSync(join(host.generationDir, MAC_DAEMON_HOST_RECORD), '{')
    run.mockClear()
    await pruneMacDaemonHosts()
    expect(run).not.toHaveBeenCalled()
  })
  it('mismatched program or target cannot authorize deletion', () => {
    expect(
      classifyMacLaunchdJob(
        output('state = not running\nlast exit code = 0').replace(host.execPath, '/foreign'),
        host
      ).status
    ).toBe('unverifiable')
    expect(
      classifyMacLaunchdJob(
        'foreign = {\nprogram = /foreign\nstate = not running\nlast exit code = 0',
        host
      ).status
    ).toBe('unverifiable')
  })
  it('accepts a realistic 20KB job print within a bounded larger capture', async () => {
    const environment = Array.from(
      { length: 80 },
      (_, i) => `DEVELOPER_${i} => ${'x'.repeat(200)}`
    ).join('\n')
    const large = output(`environment = {\n${environment}\n}\nstate = running\npid = 42`)
    expect(Buffer.byteLength(large)).toBeGreaterThan(16_384)
    run.mockResolvedValue({ code: 0, stdout: large, timedOut: false })
    expect(await inspectMacLaunchdJob(host)).toEqual({ status: 'live', pid: 42 })
    expect(run.mock.calls[0][0].maxOutputBytes).toBe(256 * 1024)
  })
  it('never bootouts before positive process exit, and reclaims after the job record disappears', async () => {
    vi.useFakeTimers()
    let live = true
    let removed = false
    run.mockImplementation(async (spec) => {
      if (spec.args[0] === 'bootout') {
        expect(live).toBe(false)
        removed = true
        return { code: 0 }
      }
      return {
        code: removed ? 3 : 0,
        stdout: output(
          live ? 'state = running\npid = 42' : 'state = not running\nlast exit code = 0'
        )
      }
    })
    try {
      const pending = bootoutMacLaunchdJob(host)
      await vi.advanceTimersByTimeAsync(500)
      expect(removed).toBe(false)
      live = false
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toBe(true)
      await pruneMacDaemonHosts()
      expect(existsSync(host.generationDir)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('retains a job that stays live and never bootouts it on a timeout', async () => {
    vi.useFakeTimers()
    run.mockResolvedValue({ code: 0, stdout: output('state = running\npid = 42') })
    try {
      const pending = bootoutMacLaunchdJob(host)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toBe(false)
      expect(run.mock.calls.some(([spec]) => spec.args[0] === 'bootout')).toBe(false)
      expect(existsSync(host.generationDir)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('cannot prune between a probe job exit and its output read in another app process', async () => {
    const unlock = lockMacDaemonHost(host)
    expect(unlock).not.toBeNull()
    await pruneMacDaemonHosts()
    expect(run).not.toHaveBeenCalled()
    expect(existsSync(host.generationDir)).toBe(true)
    unlock?.()
    await pruneMacDaemonHosts()
    expect(existsSync(host.generationDir)).toBe(false)
  })
})
