import { app } from 'electron'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  isMacTccFolderClass,
  type DaemonPtyCwdClass,
  type MacTccFolderClass
} from '../../shared/daemon-adoption-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { readMacosBundleId, resetMacosTccPermission } from '../macos-tcc-reset'
import { enumerateDirectoryOnce } from './directory-enumeration-probe'
import {
  getMacDaemonFolderProbeHost,
  type MacDaemonFolderProbeReservation
} from './daemon-mac-folder-probe'
import { lockMacDaemonHost } from './daemon-mac-host-lock'
import { probeFolderAccessForFreshDaemon } from './daemon-folder-access-probe'
import { track } from '../telemetry/client'
import {
  getDaemonFolderAccessMismatch,
  getDaemonFolderAccessTarget,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice,
  type FreshDaemonAccess
} from './daemon-folder-access-mismatch'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

/**
 * `unsupported` covers every reason the remedy does not apply — no stored evidence, a folder class
 * TCC has no service for, another platform, or a bundle id we cannot read — because the dialog
 * says the same thing to the user for all of them.
 */
export type DaemonFolderAccessResetResult =
  | { outcome: 'unsupported' }
  | { outcome: 'reset_failed' }
  | { outcome: 'probed'; mismatch: DaemonFolderAccessMismatchNotice | null }

const TCC_SERVICE_BY_CWD_CLASS: Record<MacTccFolderClass, string> = {
  documents: 'SystemPolicyDocumentsFolder',
  desktop: 'SystemPolicyDesktopFolder',
  downloads: 'SystemPolicyDownloadsFolder'
}

/** TCC logs on packaged macOS identify the outer bundle as subject, even for its launchd Helper. */
function runningAppBundlePath(): string {
  return resolve(dirname(app.getPath('exe')), '..', '..')
}

/** An unanswered macOS sheet must not keep the fix dialog busy for the rest of the session. */
const PROMPT_DEADLINE_MS = 60_000

async function promptByReadingFolder(
  path: string,
  reservation?: MacDaemonFolderProbeReservation
): Promise<boolean> {
  if (reservation) {
    return (
      (await probeFolderAccessForFreshDaemon(path, {
        timeoutMs: PROMPT_DEADLINE_MS,
        reservation
      })) !== 'unknown'
    )
  }
  let deadline: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      // The outcome is the re-probe's job; this read exists only to raise the prompt.
      enumerateDirectoryOnce(path).then(() => true),
      new Promise<false>((resolve) => {
        deadline = setTimeout(() => resolve(false), PROMPT_DEADLINE_MS)
      })
    ])
  } finally {
    clearTimeout(deadline)
  }
}

const RESET_OUTCOME_ACTION = {
  allowed: 'reset_outcome_allowed',
  denied: 'reset_outcome_still_denied',
  unknown: 'reset_outcome_unknown'
} as const satisfies Record<FreshDaemonAccess, EventProps<'daemon_folder_access_notice'>['action']>

/**
 * Emitted from main, not the renderer: nobody has verified this remedy on an affected machine, so
 * the verdict the re-probe returns is the only evidence the feature works.
 */
function emitResetOutcome(cwdClass: DaemonPtyCwdClass, access: FreshDaemonAccess): void {
  try {
    track('daemon_folder_access_notice', {
      action: RESET_OUTCOME_ACTION[access],
      cwd_class: cwdClass
    })
  } catch {
    // Best-effort: a dropped event must not turn a completed reset into a failure.
  }
}

export async function resetFolderAccessForDaemon(
  identity: DaemonEndpointIdentity | null
): Promise<DaemonFolderAccessResetResult> {
  if (process.platform !== 'darwin') {
    return { outcome: 'unsupported' }
  }
  const target = getDaemonFolderAccessTarget(identity)
  if (!target || !isMacTccFolderClass(target.cwdClass)) {
    return { outcome: 'unsupported' }
  }
  const host = getMacDaemonFolderProbeHost()
  if (host === null) {
    return { outcome: 'unsupported' }
  }
  const bundle = host
    ? join(host.generationDir, relative(host.generationDir, host.execPath).split(sep)[0])
    : runningAppBundlePath()
  const bundleId = await readMacosBundleId(bundle)
  if (bundleId === null) {
    return { outcome: 'unsupported' }
  }
  const unlock = host ? lockMacDaemonHost(host) : undefined
  if (host && !unlock) {
    return { outcome: 'unsupported' }
  }
  let handedOff = false
  let resetSucceeded = false
  const service = TCC_SERVICE_BY_CWD_CLASS[target.cwdClass]
  const resetPermission = async (): Promise<boolean> => {
    resetSucceeded = (await resetMacosTccPermission(service, bundleId)).ok
    return resetSucceeded
  }
  let prompted: boolean
  try {
    if (host && unlock) {
      handedOff = true
      prompted = await promptByReadingFolder(target.canonicalPath, {
        host,
        release: unlock,
        beforeRead: resetPermission
      })
    } else {
      if (!(await resetPermission())) {
        return { outcome: 'reset_failed' }
      }
      prompted = await promptByReadingFolder(target.canonicalPath)
    }
  } finally {
    if (!handedOff) {
      unlock?.()
    }
  }
  if (!resetSucceeded) {
    return { outcome: 'reset_failed' }
  }
  // Why no probe once the deadline passes: the sheet is still up, and a probe under it would read
  // as denied — a verdict about the unanswered prompt, not about the permission.
  if (prompted) {
    await refreshDaemonFolderAccessProbe(identity, { force: true })
  }
  const mismatch = getDaemonFolderAccessMismatch(identity)
  // One access for the event and the dialog: with the prompt unanswered the stored verdict predates
  // the reset, so reporting it as the reset's would claim a denial nothing has re-read.
  const access = prompted ? (mismatch?.freshDaemonAccess ?? 'unknown') : 'unknown'
  emitResetOutcome(target.cwdClass, access)
  return { outcome: 'probed', mismatch: mismatch && { ...mismatch, freshDaemonAccess: access } }
}
