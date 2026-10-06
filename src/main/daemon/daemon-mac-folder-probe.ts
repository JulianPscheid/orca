import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { getDaemonRuntimeDir } from './daemon-launch-paths'
import { getDaemonPidPath } from './daemon-spawner'
import {
  findOwnedMacDaemonHost,
  isPackagedMacDaemonHost,
  type MacDaemonHost
} from './daemon-mac-host'
import { lockMacDaemonHost } from './daemon-mac-host-lock'
import { bootoutMacLaunchdJob } from './daemon-mac-job-retirement'
import { bootstrapMacLaunchdJob, inspectMacLaunchdJob } from './daemon-mac-launchd-job'

/** Undefined is a fork subject; null means the packaged daemon's subject is unverifiable. */
export function getMacDaemonFolderProbeHost(): MacDaemonHost | null | undefined {
  if (!isPackagedMacDaemonHost()) {
    return undefined
  }
  const record = readDaemonPidRecord(getDaemonPidPath(getDaemonRuntimeDir()))
  if (!record?.spawnerExecPath) {
    return null
  }
  return findOwnedMacDaemonHost(record.spawnerExecPath) ?? undefined
}

/** Reuse the actual daemon's bundle; no copy or signature check occurs on a focus refresh. */
export async function probeMacDaemonFolder(
  script: string,
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 3_000
): Promise<string | null | undefined> {
  const host = getMacDaemonFolderProbeHost()
  if (!host) {
    return host
  }
  const unlock = lockMacDaemonHost(host)
  if (!unlock) {
    return null
  }
  const generation = randomUUID()
  const job = {
    ...host,
    generationDir: join(host.generationDir, `probe-${generation}`),
    jobTarget: `gui/${process.getuid?.()}/com.stablyai.orca.folder-probe.${generation}`
  }
  const deadlineMs = Date.now() + timeoutMs
  let timer: NodeJS.Timeout | undefined
  const run = async (): Promise<string | null> => {
    let attempted = false
    try {
      mkdirSync(job.generationDir, { mode: 0o700 })
      attempted = true
      await bootstrapMacLaunchdJob(
        job,
        ['-e', script, path],
        getAppEnvironment().getPath('userData'),
        env,
        deadlineMs
      )
      while (Date.now() < deadlineMs) {
        const evidence = await inspectMacLaunchdJob(job, deadlineMs)
        if (evidence.status === 'exited') {
          if (evidence.exitCode !== 0) {
            return null
          }
          const output = readFileSync(join(job.generationDir, 'stdout.log'), 'utf8')
          return Buffer.byteLength(output) <= 1024 ? output : null
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, Math.max(0, deadlineMs - Date.now())))
        )
      }
      return null
    } catch {
      return null
    } finally {
      // After the caller's deadline cleanup continues off the UI path, with the bundle still pinned.
      if (!attempted || (await bootoutMacLaunchdJob(job))) {
        try {
          rmSync(job.generationDir, { recursive: true, force: true })
          unlock()
        } catch {
          /* A failed cleanup keeps the reservation. */
        }
      }
    }
  }
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
