import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getDaemonEntryPath } from './daemon-launch-paths'
import { getMacDaemonLaunchStrategy } from './daemon-mac-launch'
import { isPackagedMacDaemonHost, materializeMacDaemonHost } from './daemon-mac-host'
import {
  bootstrapMacLaunchdJob,
  bootoutMacLaunchdJob,
  inspectMacLaunchdJob
} from './daemon-mac-launchd-job'

/** Undefined selects the existing fork probe; null means the launchd probe could not answer. */
export async function probeMacDaemonFolder(
  script: string,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<string | null | undefined> {
  if (!isPackagedMacDaemonHost() || getMacDaemonLaunchStrategy() === 'fork') {
    return undefined
  }
  const host = await materializeMacDaemonHost(getDaemonEntryPath())
  if (!host) {
    return undefined
  }
  try {
    await bootstrapMacLaunchdJob(
      host,
      ['-e', script, path],
      getAppEnvironment().getPath('userData'),
      env
    )
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const evidence = await inspectMacLaunchdJob(host)
      if (evidence.status === 'exited') {
        if (evidence.exitCode !== 0) {
          return null
        }
        const output = readFileSync(join(host.generationDir, 'stdout.log'), 'utf8')
        return Buffer.byteLength(output) <= 1024 ? output : null
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  } catch {
    return null
  } finally {
    const evidence = await inspectMacLaunchdJob(host)
    const removed = await bootoutMacLaunchdJob(host)
    if (evidence.status === 'exited' && removed) {
      try {
        rmSync(host.generationDir, { recursive: true, force: true })
      } catch {
        /* Keep uncertain cleanup. */
      }
    }
  }
}
