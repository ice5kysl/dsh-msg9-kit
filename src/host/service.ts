/**
 * Shared msg9 operations used by both faces of dsh-msg9-kit: the model tools
 * (host) and the `/dsh-msg9/*` HTTP bridge that feeds the browser panel.
 *
 * The unit of identity is the **workspace inbox**: one msg9 address per dsh
 * workspace, optionally managed under the instance-wide owner (tenant). Both
 * faces resolve a workspace to the same inbox, so an agent and its human look
 * at exactly the same mailbox.
 *
 * @module dsh-msg9-kit/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { ownerCreateAgents, ownerDisableAgent, ownerMe, ownerMoveMail, registerAgent, setForwarding, setSigningKey, type AgentProfile, type RegisteredAgent } from './api.ts'
import { generateSigningMaterial } from './signing.ts'
import { L } from './locale.ts'
import {
  defaultApiUrl,
  deleteWorkspaceInbox,
  getOwner,
  getWorkspaceInbox,
  replaceWorkspaceInbox,
  setOwner,
  upsertWorkspaceInbox,
  type OwnerState,
  type WorkspaceInbox,
} from './store.ts'
import { deriveAddress, deriveTenantFallback, resolveWorkspace, type CallerAgent, type CurrentWorkspace } from './workspace.ts'

/** A resolved workspace together with its msg9 inbox. */
export interface InboxContext {
  workspace: CurrentWorkspace
  inbox: WorkspaceInbox
  /** True when this call created the inbox. */
  provisioned: boolean
}

/** The synthetic bucket used when the host cannot name the calling workspace. */
export const DEFAULT_WORKSPACE: CurrentWorkspace = { key: 'default', title: 'default', path: '(unknown)' }

/** Effective owner (tenant) and API base for this process. */
export async function ownerContext(): Promise<{ owner: OwnerState | undefined; apiUrl: string }> {
  const owner = await getOwner()
  const apiUrl = owner?.api_url || defaultApiUrl()
  // One-time lazy probe: an owner bound before the server learned about tenant
  // slugs has `slug === undefined` in the state file. Ask /owner/me once and
  // persist the answer (`null` = flat namespace; per the server spec, existing
  // owners never gain a slug later, so a persisted null stays correct).
  // The ORG upgrade (v1.22) added address_domain: re-probe when it is missing
  // so previews/legacy-detection/display track the pod's real domain.
  if (owner?.api_key && (owner.slug === undefined || owner.address_domain === undefined) && !process.env.MSG9_OWNER_KEY) {
    try {
      const me = await ownerMe(apiUrl, owner.api_key)
      const probed: OwnerState = {
        ...owner,
        slug: typeof me.slug === 'string' ? me.slug : null,
        ...(typeof me.mail_domain === 'string' ? { mail_domain: me.mail_domain } : {}),
        address_domain: typeof me.address_domain === 'string' ? me.address_domain : null,
      }
      await setOwner(probed)
      return { owner: probed, apiUrl }
    } catch {
      // Probe is best-effort: leave the owner unprobed so a later call retries.
    }
  }
  return { owner, apiUrl }
}

/** In-flight provisioning, so two concurrent callers create one inbox. */
const provisioning = new Map<string, Promise<InboxContext>>()

/**
 * Resolve a workspace's inbox, provisioning it on first use: under the owner
 * when an owner key is configured (no IP rate limit, tenant managed),
 * otherwise by public self-registration.
 */
export function ensureInbox(workspace: CurrentWorkspace, signal?: AbortSignal): Promise<InboxContext> {
  const pending = provisioning.get(workspace.key)
  if (pending) return pending
  // The shared task must not carry any single caller's signal: the first
  // caller disconnecting would otherwise abort provisioning for every waiter.
  // Outbound calls inside rely on the API client's own timeout instead.
  const task = provision(workspace).finally(() => provisioning.delete(workspace.key))
  provisioning.set(workspace.key, task)
  if (!signal) return task
  if (signal.aborted) return Promise.reject(signal.reason)
  // A caller may stop waiting, but the shared task runs to completion.
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  ])
}

async function provision(workspace: CurrentWorkspace): Promise<InboxContext> {
  let existing = await getWorkspaceInbox(workspace.key)
  if (!existing?.api_key) {
    // Key-continuity migration: before the workspace registry was injected
    // properly, every workspace fell back to a `cwd:<path>` bucket. Move such
    // an inbox under the registry key instead of provisioning a second one.
    const legacyKey = `cwd:${workspace.path}`
    if (legacyKey !== workspace.key) {
      const legacy = await getWorkspaceInbox(legacyKey)
      if (legacy?.api_key) {
        await upsertWorkspaceInbox(workspace.key, legacy)
        await deleteWorkspaceInbox(legacyKey)
        existing = legacy
      }
    }
  }
  if (existing?.api_key) return { workspace, inbox: await ensureSigningKey(workspace.key, existing), provisioned: false }

  const { owner, apiUrl } = await ownerContext()
  const profile = workspaceProfile(workspace)
  const agent: RegisteredAgent = owner?.api_key
    ? await provisionUnderOwner(apiUrl, owner, workspace, profile)
    : await registerAgent(apiUrl, deriveAddress(workspace), undefined, profile)

  const inbox: WorkspaceInbox = {
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl,
    title: workspace.title,
    path: workspace.path,
  }
  await upsertWorkspaceInbox(workspace.key, inbox)
  return { workspace, inbox: await ensureSigningKey(workspace.key, inbox), provisioned: true }
}

/**
 * Lazily install this inbox's Ed25519 signing key (v1.3 identity): generate a
 * seed, register the public half with msg9 (first-time installs need only
 * API-key auth), persist the seed. Servers without the identity layer skip
 * quietly — unsigned sends are still accepted (warn mode).
 */
export async function ensureSigningKey(key: string, inbox: WorkspaceInbox, log?: (message: string) => void): Promise<WorkspaceInbox> {
  if (inbox.signing_seed) return inbox
  const material = generateSigningMaterial()
  try {
    await setSigningKey(inbox.api_url, inbox.api_key, material.publicKey)
  } catch (error) {
    // N1 (audit): never degrade silently. Two distinct causes: a pre-identity
    // server (expected, unsigned is fine there) vs an install failure on an
    // identity-capable server (seed missing + key on file = signing stays
    // off forever unless someone notices).
    log?.(`msg9 signing key install failed for ${inbox.address}: ${(error as Error)?.message ?? String(error)}`)
    return inbox
  }
  const signed = { ...inbox, signing_seed: material.seed }
  await upsertWorkspaceInbox(key, signed)
  return signed
}

/**
 * Provision under the owner. Tenant subdomain (`<agent>@<tenant>.msg9.io`):
 * uniqueness is scoped to the tenant, so try the readable address first and
 * fall back to the hashed form only on a conflict (server code 40900).
 */
async function provisionUnderOwner(apiUrl: string, owner: OwnerState, workspace: CurrentWorkspace, profile: AgentProfile): Promise<RegisteredAgent> {
  const candidates = owner.slug
    ? [...new Set([deriveAddress(workspace, { tenant: true }), deriveTenantFallback(workspace)])]
    : [deriveAddress(workspace)]
  let lastAddress = candidates[0]!
  let lastReason = 'no agent returned'
  for (const address of candidates) {
    lastAddress = address
    const result = await ownerCreateAgents(apiUrl, owner.api_key, [address], { workspace: workspace.title }, profile)
    const created = result.created?.[0]
    if (created?.api_key) return created
    const first = result.errors?.[0]
    lastReason = first ? `${first.message} (${first.code})` : 'no agent returned'
    if (first?.code !== 40900) break
  }
  throw new Error(
    L(
      '在 owner 下开通「{address}」失败：{reason}',
      'Failed to provision "{address}" under the owner: {reason}',
      { address: lastAddress, reason: lastReason },
    ),
  )
}

/** The yellow-pages profile written at provisioning time. */
function workspaceProfile(workspace: CurrentWorkspace): AgentProfile {
  return {
    display_name: workspace.title,
    description: L(
      'dsh workspace「{title}」的收件箱（{path}）',
      'Inbox of dsh workspace "{title}" ({path})',
      { title: workspace.title, path: workspace.path },
    ),
    links: { workspace: workspace.path },
    visibility: 'public',
  }
}

/**
 * Tenant migration, v1.9 order (forward → move history → release):
 *
 *   1. provision a FRESH inbox for the workspace under the current owner
 *      (tenant-domain address), replace the state entry (cursors reset — they
 *      belong to the old inbox's stream);
 *   2. set forwarding on the OLD inbox → the new address, with the old inbox's
 *      OWN key (no old-tenant owner key needed): the old address keeps
 *      receiving into the new mailbox, and stays reserved so nobody can
 *      re-register it and hijack delivery;
 *   3. when the previous tenant's key is supplied: move the old inbox's
 *      history over (same-tenant only — cross-tenant move-mail is a 403 the
 *      server refuses, reported in the note) and suspend the old agent. The
 *      forwarding rule survives the release.
 */
export async function migrateInbox(
  workspace: CurrentWorkspace,
  oldInbox: WorkspaceInbox,
  oldOwnerKey?: string,
): Promise<{ inbox: WorkspaceInbox; oldDisabled: boolean; forwarding: boolean; movedMail: number | null; note?: string }> {
  const { owner, apiUrl } = await ownerContext()
  if (!owner?.api_key) {
    throw new Error(L('还没有绑定租户，无法迁移。', 'No tenant is bound; cannot migrate.'))
  }
  const agent = await provisionUnderOwner(apiUrl, owner, workspace, workspaceProfile(workspace))
  const inbox: WorkspaceInbox = await ensureSigningKey(workspace.key, {
    address: agent.address,
    api_key: agent.api_key,
    api_url: apiUrl,
    title: workspace.title,
    path: workspace.path,
  })
  await replaceWorkspaceInbox(workspace.key, inbox)
  if (oldInbox.address === agent.address) {
    return { inbox, oldDisabled: false, forwarding: false, movedMail: null }
  }

  // Step 2: forwarding first, so mail never lands in a mailbox nobody reads.
  let forwarding = false
  let note: string | undefined
  try {
    await setForwarding(oldInbox.api_url, oldInbox.api_key, agent.address)
    forwarding = true
  } catch (error) {
    note = L(
      '旧地址转发设置失败（{reason}）——旧信箱仍可能收到新邮件。',
      'Could not set forwarding on the old address ({reason}) — new mail may still arrive there.',
      { reason: (error as Error)?.message ?? String(error) },
    )
  }

  // Step 3: history + release, when the previous tenant's key is around.
  let oldDisabled = false
  let movedMail: number | null = null
  if (oldOwnerKey) {
    try {
      const moved = await ownerMoveMail(oldInbox.api_url, oldOwnerKey, oldInbox.address, { to: agent.address })
      movedMail = typeof moved.moved === 'number' ? moved.moved : null
    } catch (error) {
      // Same-tenant only: a cross-tenant move is a 403 by design.
      note = L(
        '历史邮件未搬运（{reason}）。跨租户时 msg9 不支持搬信，旧邮件留在旧信箱。',
        'History not moved ({reason}). msg9 cannot move mail across tenants; old mail stays in the old inbox.',
        { reason: (error as Error)?.message ?? String(error) },
      )
    }
    try {
      await ownerDisableAgent(oldInbox.api_url, oldOwnerKey, oldInbox.address)
      oldDisabled = true
    } catch {
      /* decommission is best-effort: forwarding already covers delivery */
    }
  }
  return { inbox, oldDisabled, forwarding, movedMail, ...(note ? { note } : {}) }
}

/** Resolve the calling agent's workspace and its inbox. */
export function resolveInbox(ctx: Context, exec?: CallerAgent): Promise<InboxContext> {
  return ensureInbox(resolveWorkspace(ctx, exec) ?? DEFAULT_WORKSPACE)
}

/** Display/format helpers shared with the browser face. */
export { bodyText, maskKey, truncate } from '../shared/message.ts'
