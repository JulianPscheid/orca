import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { macDaemonHostRoot, readMacDaemonHost, type MacDaemonHost } from './daemon-mac-host'
import { PRIVATE_FILE_MODE } from './daemon-private-file-modes'

export type MacLaunchdJob = MacDaemonHost & { jobTarget: string }
export type MacLaunchdJobEvidence = ProcessLivenessVerdict & {
  pid?: number
  exitCode?: number
  exitSignal?: number
}

function xml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function buildMacLaunchdPlist(
  job: MacLaunchdJob,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): string {
  const strings = (values: string[]): string =>
    values.map((value) => `<string>${xml(value)}</string>`).join('')
  const environment = Object.entries(env)
    .flatMap(([key, value]) =>
      value === undefined ? [] : [`<key>${xml(key)}</key><string>${xml(value)}</string>`]
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${xml(job.jobTarget.split('/').at(-1) ?? '')}</string>
<key>ProgramArguments</key><array>${strings([job.execPath, ...args])}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>EnvironmentVariables</key><dict>${environment}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Interactive</string>
<key>AbandonProcessGroup</key><true/>
<key>ExitTimeOut</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(join(job.generationDir, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(job.generationDir, 'stderr.log'))}</string>
</dict></plist>`
}

async function launchctl(args: string[]) {
  return runProcess({ program: '/bin/launchctl', args, timeoutMs: 5_000, maxOutputBytes: 16_384 })
}

export async function bootstrapMacLaunchdJob(
  job: MacLaunchdJob,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const plist = join(job.generationDir, `${job.jobTarget.split('/').at(-1)}.plist`)
  writeFileSync(plist, buildMacLaunchdPlist(job, args, cwd, env), {
    flag: 'wx',
    mode: PRIVATE_FILE_MODE
  })
  for (const name of ['stdout.log', 'stderr.log']) {
    writeFileSync(join(job.generationDir, name), '', { flag: 'wx', mode: PRIVATE_FILE_MODE })
  }
  const result = await launchctl([
    'bootstrap',
    job.jobTarget.slice(0, job.jobTarget.lastIndexOf('/')),
    plist
  ])
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`launchd bootstrap failed: ${result.stderr}`)
  }
}

export function classifyMacLaunchdJob(output: string, job: MacLaunchdJob): MacLaunchdJobEvidence {
  if (
    !output.startsWith(`${job.jobTarget} = {`) ||
    !output.split('\n').some((line) => line.trim() === `program = ${job.execPath}`)
  ) {
    return { status: 'unverifiable', reason: 'launchd job identity could not be verified' }
  }
  const pid = /^\s*pid = (\d+)\s*$/m.exec(output)
  if (pid && Number(pid[1]) > 0) {
    return { status: 'live', pid: Number(pid[1]) }
  }
  const exit = /^\s*last exit code = (-?\d+)\s*$/m.exec(output)
  const signal = /^\s*last terminating signal = [^:\r\n]+: (\d+)\s*$/m.exec(output)
  if (
    /^\s*state = (?:not running|exited)\s*$/m.test(output) &&
    (exit || (signal && Number(signal[1]) > 0))
  ) {
    return {
      status: 'exited',
      ...(exit ? { exitCode: Number(exit[1]) } : { exitSignal: Number(signal?.[1]) })
    }
  }
  return { status: 'unverifiable', reason: 'launchd has no positive exit evidence' }
}

export async function inspectMacLaunchdJob(job: MacLaunchdJob): Promise<MacLaunchdJobEvidence> {
  try {
    const result = await launchctl(['print', job.jobTarget])
    if (result.code === 0 && !result.timedOut && !result.outputTruncated) {
      return classifyMacLaunchdJob(result.stdout, job)
    }
  } catch {
    /* Missing contact does not prove process exit. */
  }
  return { status: 'unverifiable', reason: 'launchd job could not be queried' }
}

/** Only an attempt owner may stop its job; the pruner calls this after positive job exit. */
export async function bootoutMacLaunchdJob(job: MacLaunchdJob): Promise<boolean> {
  try {
    const result = await launchctl(['bootout', job.jobTarget])
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}

export function macLaunchdStartupError(job: MacLaunchdJob): string {
  let fd: number | undefined
  try {
    fd = openSync(join(job.generationDir, 'stderr.log'), 'r')
    const size = fstatSync(fd).size
    const tail = Buffer.alloc(Math.min(size, 8192))
    const read = readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length))
    return tail.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/** Keep the exited job as positive retirement evidence for the next prune. */
export async function terminateMacLaunchdJob(job: MacLaunchdJob): Promise<void> {
  const before = await inspectMacLaunchdJob(job)
  if (before.status === 'exited') {
    return
  }
  if (before.status !== 'live') {
    throw new Error('Cannot verify owned daemon job for shutdown')
  }
  for (const [signal, waitMs] of [
    ['SIGTERM', 5_000],
    ['SIGKILL', 1_000]
  ] as const) {
    const result = await launchctl(['kill', signal, job.jobTarget])
    if (result.code !== 0 || result.timedOut) {
      throw new Error('Could not signal owned daemon job')
    }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if ((await inspectMacLaunchdJob(job)).status === 'exited') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Owned daemon job did not exit')
}

/** PID files are deliberately irrelevant: the reservation covers every protocol and startup window. */
export async function pruneMacDaemonHosts(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    const root = macDaemonHostRoot()
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      const host = readMacDaemonHost(join(root, entry.name))
      if (!host) {
        continue
      }
      const evidence = await inspectMacLaunchdJob(host)
      if (evidence.status === 'exited' && (await bootoutMacLaunchdJob(host))) {
        rmSync(host.generationDir, { recursive: true, force: true })
      }
    }
  } catch {
    /* Unreadable evidence keeps the host. */
  }
}
