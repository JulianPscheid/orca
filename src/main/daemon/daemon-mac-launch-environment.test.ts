import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { prepareMacDaemonEnvironment } from './daemon-mac-launch-environment'
import { buildMacLaunchdPlist } from './daemon-mac-launchd-job'

let dir: string | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('private launch environment handoff', () => {
  it('preserves a large user environment before module load without storing values in launchd', async () => {
    const scratch = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-mac-reloc')
    mkdirSync(scratch, { recursive: true })
    dir = mkdtempSync(join(scratch, 'env-test-'))
    const values = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`DEVELOPER_${i}`, 'x'.repeat(200)])
    )
    for (const [name, value] of Object.entries(values)) {
      vi.stubEnv(name, value)
    }
    vi.stubEnv('TEST_API_TOKEN', 'private-test-value')
    const host = {
      generationDir: dir,
      execPath: process.execPath,
      entryPath: '/entry.js',
      jobTarget: 'gui/501/test'
    }
    const environment = prepareMacDaemonEnvironment(host, '/profile')
    try {
      const plist = buildMacLaunchdPlist(host, environment.args, dir, environment.env)
      expect(plist).not.toContain('DEVELOPER_')
      expect(plist).not.toContain('private-test-value')
      expect(Buffer.byteLength(plist)).toBeLessThan(4096)
      const payload = join(dir, 'launch-environment.json')
      if (process.platform !== 'win32') {
        expect(statSync(payload).mode & 0o777).toBe(0o600)
      }
      const result = await runProcess({
        program: process.execPath,
        args: [
          ...environment.args,
          '-e',
          `process.stdout.write(JSON.stringify({value:process.env.DEVELOPER_79,token:process.env.TEST_API_TOKEN,profile:process.env.ORCA_USER_DATA_PATH,consumed:!require('node:fs').existsSync(${JSON.stringify(payload)})}))`
        ],
        env: environment.env,
        maxOutputBytes: 4096,
        timeoutMs: 3000
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        value: values.DEVELOPER_79,
        token: 'private-test-value',
        profile: '/profile',
        consumed: true
      })
      expect(existsSync(payload)).toBe(false)
      expect(readFileSync(join(dir, 'launch-environment.cjs'), 'utf8')).not.toContain(
        'private-test-value'
      )
    } finally {
      environment.dispose()
    }
  })
})
