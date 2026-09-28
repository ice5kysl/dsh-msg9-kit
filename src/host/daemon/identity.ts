/**
 * Identity enumeration for the msg9 watcher daemon.
 *
 * The daemon watches exactly the dsh harness's inboxes: it reads
 * `~/.msg9/projects/dsh/*.yaml` — the prefix is HARD-CODED here, other
 * harnesses' credentials (kimi-code, claude-code, …) are never enumerated.
 * Read-only: provisioning and rotation stay with the plugins.
 *
 * @module dsh-msg9-kit/daemon/identity
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { msg9Home, readProjectCredentials } from '../credentials.ts'

/** One watchable inbox: a dsh project credential plus its local key. */
export interface DaemonIdentity {
  /** The credential file stem (`~/.msg9/projects/dsh/<project_key>.yaml`). */
  project_key: string
  address: string
  api_key: string
  api_url: string
}

/** The dsh-only projects directory (hard-coded credential boundary). */
export function dshProjectsDir(): string {
  return join(msg9Home(), 'projects', 'dsh')
}

/**
 * Enumerate every dsh inbox on this machine. Missing/unreadable directories
 * yield an empty list (nothing provisioned yet is a normal state); malformed
 * entries are skipped individually — one bad file must not blind the rest.
 */
export async function enumerateIdentities(log: (message: string) => void = () => {}): Promise<DaemonIdentity[]> {
  let entries: string[]
  try {
    entries = await readdir(dshProjectsDir())
  } catch {
    return []
  }
  const identities: DaemonIdentity[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.yaml') || entry.endsWith('.signing.yaml')) continue
    const projectKey = entry.slice(0, -'.yaml'.length)
    if (!projectKey) continue
    try {
      const creds = await readProjectCredentials(projectKey)
      if (!creds) {
        log(`msg9 daemon: skipping unreadable credential ${entry}`)
        continue
      }
      identities.push({
        project_key: projectKey,
        address: creds.address,
        api_key: creds.api_key,
        api_url: creds.api_url,
      })
    } catch (error) {
      log(`msg9 daemon: skipping credential ${entry}: ${(error as Error)?.message ?? String(error)}`)
    }
  }
  return identities
}
