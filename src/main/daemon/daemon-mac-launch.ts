import { DaemonClient } from './client'
import { holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import { DaemonEndpointUnavailableError } from './daemon-launched-child'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { materializeMacDaemonHost } from './daemon-mac-host'
import {
  bootstrapMacLaunchdJob,
  bootoutMacLaunchdJob,
  inspectMacLaunchdJob,
  macLaunchdStartupError,
  terminateMacLaunchdJob
} from './daemon-mac-launchd-job'
import type { DaemonProcessHandle } from './daemon-spawner'

const STARTUP_MS = 15_000
let launchStrategy: 'launchd' | 'fork' | null = null

export function getMacDaemonLaunchStrategy(): 'launchd' | 'fork' | null {
  return launchStrategy
}

/** Null means the installed-runtime fork remains the actual launch strategy. */
export async function launchMacDaemon(
  options: DaemonChildSpawnOptions
): Promise<DaemonProcessHandle | null> {
  const host = await materializeMacDaemonHost(options.forkEntryPath)
  if (!host) {
    launchStrategy = 'fork'
    return null
  }
  let client: DaemonClient | null = null
  try {
    await bootstrapMacLaunchdJob(
      host,
      [host.entryPath, ...buildDaemonScriptArgs(options, host.execPath)],
      options.userDataPath,
      {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_USER_DATA_PATH: options.userDataPath
      }
    )
    const deadline = Date.now() + STARTUP_MS
    while (Date.now() < deadline) {
      client ??= new DaemonClient({ socketPath: options.socketPath, tokenPath: options.tokenPath })
      try {
        await client.ensureConnectedWithin(Math.min(250, deadline - Date.now()))
      } catch {
        client.disconnect()
        client = null
      }
      const job = await inspectMacLaunchdJob(host)
      if (client) {
        const identity = client.getDaemonIdentity()
        if (identity && identity.launchNonce !== options.launchNonce) {
          throw new DaemonEndpointUnavailableError('occupied')
        }
        if (
          identity &&
          identity.launchNonce === options.launchNonce &&
          job.status === 'live' &&
          identity.pid === job.pid
        ) {
          const handle = await holdDaemonAdoptionLease(
            {
              shutdown: () => terminateMacLaunchdJob(host)
            },
            options.socketPath,
            options.tokenPath,
            client,
            identity,
            options.pidPath
          )
          client = null
          launchStrategy = 'launchd'
          console.info('[daemon] macOS daemon ready from owned host under launchd')
          return handle
        }
      }
      if (job.status === 'exited') {
        if (job.exitCode === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
          throw new DaemonEndpointUnavailableError('occupied')
        }
        throw new Error(`launchd daemon exited: ${job.exitCode ?? `signal ${job.exitSignal}`}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('launchd daemon readiness timed out')
  } catch (error) {
    client?.disconnect()
    const diagnostic = macLaunchdStartupError(host)
    // bootout names only this nonce's job; a failed removal retains its pinned bundle.
    if (!(await bootoutMacLaunchdJob(host))) {
      console.warn('[daemon] Could not remove owned launchd job; retaining pinned host')
    }
    if (error instanceof DaemonEndpointUnavailableError) {
      throw error
    }
    console.warn(
      '[daemon] macOS launchd launch failed; using installed-runtime fork:',
      error,
      diagnostic
    )
    launchStrategy = 'fork'
    return null
  }
}
