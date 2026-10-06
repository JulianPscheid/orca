import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import { DaemonEndpointUnavailableError } from './daemon-launched-child'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { materializeMacDaemonHost } from './daemon-mac-host'
import { lockMacDaemonHost } from './daemon-mac-host-lock'
import { prepareMacDaemonEnvironment } from './daemon-mac-launch-environment'
import { retireFailedMacLaunchdJob, terminateMacLaunchdJob } from './daemon-mac-job-retirement'
import {
  bootstrapMacLaunchdJob,
  inspectMacLaunchdJob,
  macLaunchdStartupError
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
  const unlock = lockMacDaemonHost(host)
  if (!unlock) {
    console.warn('[daemon] Cannot reserve unstarted macOS host; using installed-runtime fork')
    launchStrategy = 'fork'
    return null
  }
  let client: DaemonClient | null = null
  let environment: ReturnType<typeof prepareMacDaemonEnvironment> | undefined
  let bootstrapAttempted = false
  let mayDisposeEnvironment = true
  try {
    environment = prepareMacDaemonEnvironment(host, options.userDataPath)
    const args = [
      ...environment.args,
      host.entryPath,
      ...buildDaemonScriptArgs(options, host.execPath)
    ]
    bootstrapAttempted = true
    mayDisposeEnvironment = false
    await bootstrapMacLaunchdJob(host, args, options.userDataPath, environment.env)
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
          mayDisposeEnvironment = true
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
    const retired = !bootstrapAttempted || (await retireFailedMacLaunchdJob(host, error))
    mayDisposeEnvironment = retired
    if (!retired) {
      console.warn('[daemon] Owned launchd process exit is unverifiable; retaining pinned host')
      if (!(error instanceof DaemonEndpointUnavailableError) || error.reason !== 'occupied') {
        throw new Error('Cannot safely fall back before owned launchd daemon exit', {
          cause: error
        })
      }
    } else {
      try {
        rmSync(host.generationDir, { recursive: true, force: true })
      } catch {
        console.warn('[daemon] Exited launch attempt retained after host cleanup failed')
      }
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
  } finally {
    try {
      if (mayDisposeEnvironment) {
        environment?.dispose()
      }
    } finally {
      unlock()
    }
  }
}
