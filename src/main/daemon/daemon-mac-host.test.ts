import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import {
  materializeMacDaemonHost,
  isOwnedMacDaemonExecutable,
  MAC_DAEMON_HOST_RECORD
} from './daemon-mac-host'
import { classifyCodesignDisplayOutput } from './daemon-mac-code-identity'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: run }))
let root: string
let bundle: string
let entry: string
let userData: string
let packaged: boolean
const original = Object.getOwnPropertyDescriptors(process)
const supportsSymlinks = process.platform !== 'win32'
const scratch = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
function prop(name: string, value: unknown): void {
  Object.defineProperty(process, name, { value, configurable: true })
}

beforeEach(() => {
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(join(scratch, 'ShipIt-host-test-'))
  bundle = join(root, 'Orca $test.app')
  userData = join(root, 'profile')
  entry = join(
    bundle,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'out',
    'main',
    'daemon-entry.js'
  )
  const helper = join(
    bundle,
    'Contents',
    'Frameworks',
    'Orca Helper.app',
    'Contents',
    'MacOS',
    'Orca Helper'
  )
  for (const path of [entry, helper]) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, path)
  }
  if (supportsSymlinks) {
    symlinkSync('daemon-entry.js', join(entry, '..', 'link.js'))
  }
  packaged = true
  setAppEnvironment({
    getPath: () => userData,
    getAppPath: () => join(bundle, 'Contents', 'Resources', 'app.asar'),
    getVersion: () => '1.2.3',
    isPackaged: () => packaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  prop('platform', 'darwin')
  prop('execPath', join(bundle, 'Contents', 'MacOS', 'Orca'))
  prop('helperExecPath', helper)
  prop('getuid', () => 501)
  run.mockReset()
  run.mockImplementation(async (spec) => {
    if (spec.program === '/bin/cp') {
      cpSync(spec.args.at(-2), spec.args.at(-1), { recursive: true, verbatimSymlinks: true })
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  })
})
afterEach(() => {
  for (const name of ['platform', 'execPath', 'helperExecPath', 'getuid']) {
    const descriptor = original[name]
    if (descriptor) {
      Object.defineProperty(process, name, descriptor)
    } else {
      Reflect.deleteProperty(process, name)
    }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('macOS immutable daemon host', () => {
  it('publishes the full closure and reservation outside the signature seal', async () => {
    const host = await materializeMacDaemonHost(entry)
    expect(host).not.toBeNull()
    if (!host) {
      throw new Error('Missing host')
    }
    expect(readFileSync(host.entryPath, 'utf8')).toBe(entry)
    if (supportsSymlinks) {
      expect(readlinkSync(join(host.entryPath, '..', 'link.js'))).toBe('daemon-entry.js')
    }
    expect(host.execPath).toContain('Orca Helper.app')
    expect(host.jobTarget).toMatch(/^gui\/\d+\/com.stablyai.orca.terminal./)
    expect(existsSync(join(host.generationDir, MAC_DAEMON_HOST_RECORD))).toBe(true)
    expect(isOwnedMacDaemonExecutable(host.execPath)).toBe(true)
    expect(classifyCodesignDisplayOutput(`Executable=${host.execPath}`, 0)).toBe('resolved')
    expect(run.mock.calls[0][0].args.slice(0, 4)).toEqual(['-c', '-R', '-p', '-P'])
    expect(run.mock.calls[1][0].args.slice(0, 3)).toEqual(['--verify', '--deep', '--strict'])
    expect(run.mock.calls.some(([spec]) => spec.program.includes('xattr'))).toBe(false)
  })
  it('same-version and concurrent attempts never overwrite a published generation', async () => {
    const [first, second] = await Promise.all([
      materializeMacDaemonHost(entry),
      materializeMacDaemonHost(entry)
    ])
    expect(first?.generationDir).not.toBe(second?.generationDir)
    if (!first || !second) {
      throw new Error('Missing hosts')
    }
    writeFileSync(join(first.generationDir, MAC_DAEMON_HOST_RECORD), 'corrupt')
    writeFileSync(entry, 'different build of the same version')
    const third = await materializeMacDaemonHost(entry)
    expect(readFileSync(first.entryPath, 'utf8')).toBe(entry)
    expect(third && readFileSync(third.entryPath, 'utf8')).toBe(
      'different build of the same version'
    )
    expect(existsSync(second.execPath)).toBe(true)
    expect(isOwnedMacDaemonExecutable(first.execPath)).toBe(false)
  })
  it.each(['win32', 'linux'])('never copies on %s', async (platform) => {
    prop('platform', platform)
    await expect(materializeMacDaemonHost(entry)).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
  it('does not relocate dev or packaged plain-Node hosts', async () => {
    packaged = false
    await expect(materializeMacDaemonHost(entry)).resolves.toBeNull()
    packaged = true
    setAppEnvironment({
      getPath: () => userData,
      getAppPath: () => root,
      getVersion: () => '1',
      isPackaged: () => true,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    await expect(materializeMacDaemonHost(entry)).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
  it.each(['copy', 'signature', 'timeout'])(
    'fails open on %s failure without publishing a partial host',
    async (failure) => {
      const copy = run.getMockImplementation()
      run.mockImplementation(async (spec) => {
        if (failure === 'copy' || failure === 'timeout') {
          return { code: 1, stderr: 'copy failed', timedOut: failure === 'timeout' }
        }
        if (spec.program === '/usr/bin/codesign') {
          return { code: 1, stderr: 'bad seal', timedOut: false }
        }
        return copy?.(spec)
      })
      await expect(materializeMacDaemonHost(entry)).resolves.toBeNull()
    }
  )
  it('refuses an entry or Helper outside the running bundle', async () => {
    await expect(materializeMacDaemonHost(join(root, 'daemon-entry.js'))).resolves.toBeNull()
    prop('helperExecPath', '/tmp/foreign Helper')
    await expect(materializeMacDaemonHost(entry)).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
  it.skipIf(!supportsSymlinks)(
    'clones the real bundle when launched through a symlinked .app',
    async () => {
      const alias = join(root, 'Alias.app')
      symlinkSync(bundle, alias)
      prop('execPath', join(alias, 'Contents', 'MacOS', 'Orca'))
      const helper = 'helperExecPath' in process ? process.helperExecPath : undefined
      if (typeof helper !== 'string') {
        throw new Error('Missing helper fixture')
      }
      prop('helperExecPath', helper.replace(bundle, alias))
      const host = await materializeMacDaemonHost(entry.replace(bundle, alias))
      expect(host).not.toBeNull()
      expect(run.mock.calls[0][0].args.at(-2)).toBe(realpathSync(bundle))
      expect(host && readFileSync(host.entryPath, 'utf8')).toBe(entry)
    }
  )
})
