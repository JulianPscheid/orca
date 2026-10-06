import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MacDaemonHost } from './daemon-mac-host'
import { PRIVATE_FILE_MODE } from './daemon-private-file-modes'

// PTYs inherit process.env; preload it before daemon modules read any configuration.
const PRELOAD = `const fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'launch-environment.json');
const text=fs.readFileSync(file,'utf8');fs.unlinkSync(file);
const env=JSON.parse(text);
for(const key of Object.keys(process.env))delete process.env[key];
for(const [key,value]of Object.entries(env))if(typeof value==='string')process.env[key]=value;`

/** Values never enter the plist or argv; the daemon unlinks the private handoff before loading. */
export function prepareMacDaemonEnvironment(
  host: MacDaemonHost,
  userDataPath: string
): { args: string[]; env: NodeJS.ProcessEnv; dispose: () => void } {
  const payload = join(host.generationDir, 'launch-environment.json')
  const preload = join(host.generationDir, 'launch-environment.cjs')
  const dispose = (): void => rmSync(payload, { force: true })
  try {
    writeFileSync(
      payload,
      JSON.stringify({
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_USER_DATA_PATH: userDataPath
      }),
      { flag: 'wx', mode: PRIVATE_FILE_MODE }
    )
    writeFileSync(preload, PRELOAD, { flag: 'wx', mode: PRIVATE_FILE_MODE })
    return { args: ['--require', preload], env: { ELECTRON_RUN_AS_NODE: '1' }, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
