import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { getDaemonRuntimeDir } from './daemon-launch-paths'
import { getDaemonPidPath } from './daemon-spawner'
import {
  findOwnedMacDaemonHost,
  isMacDaemonHostPath,
  isPackagedMacDaemonHost,
  type MacDaemonHost
} from './daemon-mac-host'
import { lockMacDaemonHost } from './daemon-mac-host-lock'
import { PRIVATE_FILE_MODE } from './daemon-private-file-modes'
import { bootoutMacLaunchdJob, retireFailedMacLaunchdJob } from './daemon-mac-job-retirement'
import {
  bootstrapMacLaunchdJob,
  inspectMacLaunchdJob,
  type MacLaunchdJobEvidence
} from './daemon-mac-launchd-job'

export type MacDaemonFolderProbeReservation = {
  host: MacDaemonHost
  release: () => void
  beforeRead?: () => Promise<boolean>
}

/** Undefined is a fork subject; null means the packaged daemon's subject is unverifiable. */
export function getMacDaemonFolderProbeHost(): MacDaemonHost | null | undefined {
  if (!isPackagedMacDaemonHost()) {
    return undefined
  }
  const record = readDaemonPidRecord(getDaemonPidPath(getDaemonRuntimeDir()))
  if (!record?.spawnerExecPath) {
    return null
  }
  const host = findOwnedMacDaemonHost(record.spawnerExecPath)
  return host ?? (isMacDaemonHostPath(record.spawnerExecPath) ? null : undefined)
}

/** Reuse the actual daemon's bundle; no copy or signature check occurs on a focus refresh. */
export async function probeMacDaemonFolder(
  script: string,
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 3_000,
  reservation?: MacDaemonFolderProbeReservation
): Promise<string | null | undefined> {
  const host = reservation?.host ?? getMacDaemonFolderProbeHost()
  if (!host) {
    return host
  }
  const unlock = reservation?.release ?? lockMacDaemonHost(host)
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
  const gate = join(job.generationDir, 'read-permitted')
  const beforeRead = reservation?.beforeRead
  // Keep the launched subject idle until reset succeeds; a failed reset exits without a read.
  const gatedScript = `const t=setInterval(()=>{let p;try{p=require('node:fs').readFileSync(process.argv[2],'utf8')}catch(e){if(e.code==='ENOENT')return;process.exit(1)}clearInterval(t);if(p!=='read')process.exit(1);${script}},50)`
  let timer: NodeJS.Timeout | undefined
  const run = async (): Promise<string | null> => {
    let attempted = false
    let evidence: MacLaunchdJobEvidence | undefined
    let failure: unknown
    try {
      mkdirSync(job.generationDir, { mode: 0o700 })
      attempted = true
      await bootstrapMacLaunchdJob(
        job,
        beforeRead ? ['-e', gatedScript, path, gate] : ['-e', script, path],
        getAppEnvironment().getPath('userData'),
        env,
        deadlineMs
      )
      if (beforeRead) {
        let permitted = false
        try {
          permitted = Date.now() < deadlineMs && (await beforeRead())
        } finally {
          writeFileSync(`${gate}.staging`, permitted ? 'read' : 'cancel', {
            flag: 'wx',
            mode: PRIVATE_FILE_MODE
          })
          renameSync(`${gate}.staging`, gate)
        }
      }
      while (true) {
        const remaining = deadlineMs - Date.now()
        evidence = await inspectMacLaunchdJob(job, remaining > 0 ? deadlineMs : undefined)
        if (evidence.status === 'exited') {
          if (evidence.exitCode !== 0) {
            return null
          }
          const output = readFileSync(join(job.generationDir, 'stdout.log'), 'utf8')
          return Buffer.byteLength(output) <= 1024 ? output : null
        }
        if (remaining <= 0 && evidence.status !== 'live') {
          return null
        }
        await new Promise((resolve) =>
          setTimeout(resolve, remaining > 0 ? Math.min(100, remaining) : 1_000).unref()
        )
      }
    } catch (error) {
      failure = error
      return null
    } finally {
      // After the caller's deadline cleanup continues off the UI path, with the bundle still pinned.
      // A live read may own a consent sheet; the UI deadline must not terminate it.
      const retired =
        !attempted ||
        (failure
          ? await retireFailedMacLaunchdJob(job, failure, false)
          : evidence?.status === 'exited' && (await bootoutMacLaunchdJob(job)))
      if (retired) {
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
