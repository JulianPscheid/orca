import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectMacLaunchdJob, runMacLaunchctl, type MacLaunchdJob } from './daemon-mac-launchd-job'
import { PRIVATE_FILE_MODE } from './daemon-private-file-modes'

const RETIREMENT_RECORD = 'retired.json'

/** This survives bootout removing launchd's positive exit evidence. */
export function hasRetiredMacLaunchdJob(job: MacLaunchdJob): boolean {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(job.generationDir, RETIREMENT_RECORD), 'utf8')
    )
    return (
      typeof value === 'object' &&
      value !== null &&
      'jobTarget' in value &&
      value.jobTarget === job.jobTarget &&
      'execPath' in value &&
      value.execPath === job.execPath &&
      'exited' in value &&
      value.exited === true &&
      'removed' in value &&
      value.removed === true
    )
  } catch {
    return false
  }
}

/** Leave the job registered until launchd positively reports process exit, including after kill. */
export async function terminateMacLaunchdJob(
  job: MacLaunchdJob,
  deadlineMs = Date.now() + 8_000
): Promise<void> {
  const before = await inspectMacLaunchdJob(job, deadlineMs)
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
    if (Date.now() >= deadlineMs) {
      break
    }
    const result = await runMacLaunchctl(['kill', signal, job.jobTarget], deadlineMs)
    if (result.code !== 0 || result.timedOut) {
      throw new Error('Could not signal owned daemon job')
    }
    const deadline = Math.min(deadlineMs, Date.now() + waitMs)
    while (Date.now() < deadline) {
      if ((await inspectMacLaunchdJob(job, deadline)).status === 'exited') {
        return
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())))
      )
    }
  }
  throw new Error('Owned daemon job did not exit')
}

/** bootout alone is never exit proof: on macOS it can return while the process still runs. */
export async function bootoutMacLaunchdJob(
  job: MacLaunchdJob,
  deadlineMs = Date.now() + 10_000
): Promise<boolean> {
  if (hasRetiredMacLaunchdJob(job)) {
    return true
  }
  try {
    await terminateMacLaunchdJob(job, deadlineMs)
    if (
      Date.now() >= deadlineMs ||
      (await inspectMacLaunchdJob(job, deadlineMs)).status !== 'exited'
    ) {
      return false
    }
    const record = {
      jobTarget: job.jobTarget,
      execPath: job.execPath,
      exited: true,
      removed: false
    }
    const path = join(job.generationDir, RETIREMENT_RECORD)
    writeFileSync(path, JSON.stringify(record), { mode: PRIVATE_FILE_MODE })
    const result = await runMacLaunchctl(['bootout', job.jobTarget], deadlineMs)
    if (result.code !== 0 || result.timedOut) {
      return false
    }
    writeFileSync(path, JSON.stringify({ ...record, removed: true }), { mode: PRIVATE_FILE_MODE })
    return true
  } catch {
    return false
  }
}
