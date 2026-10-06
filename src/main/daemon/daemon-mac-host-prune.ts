import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { macDaemonHostRoot, readMacDaemonHost } from './daemon-mac-host'
import { lockMacDaemonHost } from './daemon-mac-host-lock'
import { bootoutMacLaunchdJob, hasRetiredMacLaunchdJob } from './daemon-mac-job-retirement'
import { inspectMacLaunchdJob } from './daemon-mac-launchd-job'

/** PID files never unpin a generation; probes and pruning serialize across app processes. */
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
      const unlock = lockMacDaemonHost(host)
      if (!unlock) {
        continue
      }
      try {
        const evidence = await inspectMacLaunchdJob(host)
        if (evidence.status === 'live') {
          continue
        }
        if (
          (evidence.status === 'exited' || hasRetiredMacLaunchdJob(host)) &&
          (await bootoutMacLaunchdJob(host))
        ) {
          rmSync(host.generationDir, { recursive: true, force: true })
        }
      } finally {
        unlock()
      }
    }
  } catch {
    /* Unreadable evidence keeps the host. */
  }
}
