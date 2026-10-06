import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { runProcess } from '../../shared/child-process/run-process'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './daemon-private-file-modes'

export type MacDaemonHost = {
  generationDir: string
  execPath: string
  entryPath: string
  jobTarget: string
}

export const MAC_DAEMON_HOST_SUBDIR = 'daemon-host-mac'
export const MAC_DAEMON_HOST_RECORD = 'host.json'

export function macDaemonHostRoot(): string {
  const profile = getAppEnvironment().getPath('userData')
  return join(existsSync(profile) ? realpathSync(profile) : profile, MAC_DAEMON_HOST_SUBDIR)
}

export function isPackagedMacDaemonHost(): boolean {
  const environment = getAppEnvironment()
  return (
    process.platform === 'darwin' &&
    environment.isPackaged() &&
    environment.getAppPath().endsWith('app.asar')
  )
}

function inside(bundle: string, path: string): string {
  const rel = relative(bundle, path)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Daemon runtime is outside the running app bundle')
  }
  return rel
}

/** One launch owns one immutable generation; a same-version reinstall can never repair a live host. */
export async function materializeMacDaemonHost(entryPath: string): Promise<MacDaemonHost | null> {
  if (!isPackagedMacDaemonHost()) {
    return null
  }
  const generation = randomUUID()
  let staging: string | undefined
  try {
    ensurePrivateDir(getAppEnvironment().getPath('userData'))
    const root = macDaemonHostRoot()
    staging = join(root, `${generation}.staging`)
    const generationDir = join(root, generation)
    const bundle = realpathSync(dirname(dirname(dirname(process.execPath))))
    if (!bundle.endsWith('.app')) {
      throw new Error('Missing packaged app bundle')
    }
    const helperPath = 'helperExecPath' in process ? process.helperExecPath : undefined
    if (typeof helperPath !== 'string' || !helperPath) {
      throw new Error('Missing Electron Helper executable')
    }
    const execRel = inside(bundle, realpathSync(helperPath))
    const entryRel = inside(bundle, realpathSync(entryPath))
    ensurePrivateDir(root)
    mkdirSync(staging, { mode: 0o700 })
    // cp -c silently copies on non-APFS. Record a request, never promise block sharing.
    const copy = await runProcess({
      program: '/bin/cp',
      args: ['-c', '-R', '-p', '-P', bundle, join(staging, basename(bundle))],
      timeoutMs: 20_000,
      maxOutputBytes: 8192,
      terminationBarrier: true
    })
    if (copy.code !== 0 || copy.timedOut) {
      throw new Error(`Bundle copy failed: ${copy.stderr}`)
    }
    const clonedBundle = join(staging, basename(bundle))
    if (!existsSync(join(clonedBundle, execRel)) || !existsSync(join(clonedBundle, entryRel))) {
      throw new Error('Incomplete daemon runtime')
    }
    const signature = await runProcess({
      program: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', clonedBundle],
      timeoutMs: 10_000,
      maxOutputBytes: 8192
    })
    if (signature.code !== 0 || signature.timedOut) {
      throw new Error('Cloned bundle signature failed')
    }
    const uid = process.getuid?.()
    if (uid === undefined) {
      throw new Error('Missing GUI user identity')
    }
    const host: MacDaemonHost = {
      generationDir,
      execPath: join(generationDir, basename(bundle), execRel),
      entryPath: join(generationDir, basename(bundle), entryRel),
      jobTarget: `gui/${uid}/com.stablyai.orca.terminal.${generation}`
    }
    // This reservation precedes assessment and bootstrap; missing launchd evidence never unpins it.
    writeFileSync(join(staging, MAC_DAEMON_HOST_RECORD), JSON.stringify(host), {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE
    })
    renameSync(staging, generationDir)
    console.info(
      '[daemon] macOS host published (APFS clone requested; full-copy fallback possible)'
    )
    return host
  } catch (error) {
    // Only unpublished scratch belongs to this materializer.
    try {
      if (staging) {
        rmSync(staging, { recursive: true, force: true })
      }
    } catch {
      /* Retain failed scratch. */
    }
    console.warn('[daemon] macOS host unavailable; using installed runtime:', error)
    return null
  }
}

export function readMacDaemonHost(generationDir: string): MacDaemonHost | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(generationDir, MAC_DAEMON_HOST_RECORD), 'utf8')
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !('generationDir' in value) ||
      value.generationDir !== generationDir ||
      !('execPath' in value) ||
      typeof value.execPath !== 'string' ||
      !('entryPath' in value) ||
      typeof value.entryPath !== 'string' ||
      !('jobTarget' in value) ||
      typeof value.jobTarget !== 'string'
    ) {
      return null
    }
    const generation = basename(generationDir)
    if (
      !/^[0-9a-f-]{36}$/.test(generation) ||
      value.jobTarget !== `gui/${process.getuid?.()}/com.stablyai.orca.terminal.${generation}`
    ) {
      return null
    }
    inside(generationDir, value.execPath)
    inside(generationDir, value.entryPath)
    return {
      generationDir,
      execPath: value.execPath,
      entryPath: value.entryPath,
      jobTarget: value.jobTarget
    }
  } catch {
    return null
  }
}

/** Shared with attribution classifiers: an intentional owned clone is a healthy location. */
export function findOwnedMacDaemonHost(path: string): MacDaemonHost | null {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    const root = macDaemonHostRoot()
    const resolvedPath = realpathSync(path)
    const rel = inside(root, resolvedPath)
    const generationDir = join(root, rel.split(sep)[0])
    const host = readMacDaemonHost(generationDir)
    return host?.execPath === resolvedPath ? host : null
  } catch {
    return null
  }
}

export function isOwnedMacDaemonExecutable(path: string): boolean {
  return findOwnedMacDaemonHost(path) !== null
}

/** A damaged owned record must never become a legacy installed-app permission subject. */
export function isMacDaemonHostPath(path: string): boolean {
  const roots = [
    macDaemonHostRoot(),
    join(getAppEnvironment().getPath('userData'), MAC_DAEMON_HOST_SUBDIR)
  ]
  return roots.some((root) => {
    try {
      inside(root, path)
      return true
    } catch {
      return false
    }
  })
}
