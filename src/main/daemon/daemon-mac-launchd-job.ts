import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import type { MacDaemonHost } from './daemon-mac-host'
import { PRIVATE_FILE_MODE } from './daemon-private-file-modes'
import { MacLaunchdBootstrapError } from './daemon-mac-bootstrap-error'

export type MacLaunchdJob = MacDaemonHost & { jobTarget: string }
export type MacLaunchdJobEvidence = ProcessLivenessVerdict & {
  pid?: number
  exitCode?: number
  exitSignal?: number
  exitReason?: string
  serviceNotFound?: true
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

export async function runMacLaunchctl(args: string[], deadlineMs = Date.now() + 5_000) {
  return runProcess({
    program: '/bin/launchctl',
    args,
    timeoutMs: Math.max(1, Math.min(5_000, deadlineMs - Date.now())),
    maxOutputBytes: 256 * 1024
  })
}

export async function bootstrapMacLaunchdJob(
  job: MacLaunchdJob,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadlineMs?: number
): Promise<void> {
  const plist = join(job.generationDir, `${job.jobTarget.split('/').at(-1)}.plist`)
  try {
    writeFileSync(plist, buildMacLaunchdPlist(job, args, cwd, env), {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE
    })
    for (const name of ['stdout.log', 'stderr.log']) {
      writeFileSync(join(job.generationDir, name), '', { flag: 'wx', mode: PRIVATE_FILE_MODE })
    }
  } catch (cause) {
    throw new MacLaunchdBootstrapError('launchd job was not submitted', 'not-submitted', { cause })
  }
  try {
    const result = await runMacLaunchctl(
      ['bootstrap', job.jobTarget.slice(0, job.jobTarget.lastIndexOf('/')), plist],
      deadlineMs
    )
    if (result.code !== 0 || result.timedOut) {
      const rejected =
        typeof result.code === 'number' && !result.timedOut && !result.outputTruncated
      throw new MacLaunchdBootstrapError(
        `launchd bootstrap failed: ${result.stderr}`,
        rejected ? 'rejected' : 'unverifiable'
      )
    }
  } catch (cause) {
    if (cause instanceof MacLaunchdBootstrapError) {
      throw cause
    }
    throw new MacLaunchdBootstrapError('launchd bootstrap outcome is unknown', 'unverifiable', {
      cause
    })
  }
}

export function classifyMacLaunchdJob(output: string, job: MacLaunchdJob): MacLaunchdJobEvidence {
  if (
    !output.startsWith(`${job.jobTarget} = {`) ||
    !output.split('\n').some((line) => line === `\tprogram = ${job.execPath}`)
  ) {
    return { status: 'unverifiable', reason: 'launchd job identity could not be verified' }
  }
  const pid = /^\tpid = (\d+)[\t ]*$/m.exec(output)
  if (pid && Number(pid[1]) > 0) {
    return { status: 'live', pid: Number(pid[1]) }
  }
  // launchctl indents service fields once, nested dictionary fields twice.
  const exit = /^\tlast exit code = (-?\d+)[\t ]*$/m.exec(output)
  const signal = /^\tlast terminating signal = [^:\r\n]+: (\d+)[\t ]*$/m.exec(output)
  const reason = /^\tlast exit reason = (JETSAM_[A-Z0-9_]+)[\t ]*$/m.exec(output)
  if (
    /^\tstate = (?:not running|exited)[\t ]*$/m.test(output) &&
    (exit || (signal && Number(signal[1]) > 0) || reason)
  ) {
    return {
      status: 'exited',
      ...(exit
        ? { exitCode: Number(exit[1]) }
        : signal && Number(signal[1]) > 0
          ? { exitSignal: Number(signal[1]) }
          : { exitReason: reason?.[1] })
    }
  }
  return { status: 'unverifiable', reason: 'launchd has no positive exit evidence' }
}

export async function inspectMacLaunchdJob(
  job: MacLaunchdJob,
  deadlineMs?: number
): Promise<MacLaunchdJobEvidence> {
  try {
    const result = await runMacLaunchctl(['print', job.jobTarget], deadlineMs)
    if (result.code === 0 && !result.timedOut && !result.outputTruncated) {
      return classifyMacLaunchdJob(result.stdout, job)
    }
    const missing = `Could not find service "${job.jobTarget.split('/').at(-1)}"`
    if (
      result.code === 113 &&
      !result.timedOut &&
      !result.outputTruncated &&
      result.stderr.includes(missing)
    ) {
      return { status: 'unverifiable', serviceNotFound: true, reason: 'launchd service is absent' }
    }
  } catch {
    /* Missing contact does not prove process exit. */
  }
  return { status: 'unverifiable', reason: 'launchd job could not be queried' }
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
