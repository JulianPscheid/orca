import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MacDaemonHost } from './daemon-mac-host'

/** A crashed holder keeps its pin; absence of its app cannot authorize bundle deletion. */
export function lockMacDaemonHost(host: MacDaemonHost): (() => void) | null {
  const lock = join(host.generationDir, 'use-lock')
  try {
    mkdirSync(lock, { mode: 0o700 })
    return () => rmSync(lock, { recursive: true, force: true })
  } catch {
    return null
  }
}
