/**
 * dsh-msg9-kit — browser (client) face.
 *
 * Official seams, one shared store:
 *
 *  1. `conversation.view` (list/session) — a「消息」view tab registered after
 *     the shipped chat (0), trajectory (10) and files (20) tabs, so the
 *     session header reads 对话 | 轨迹 | 文件 | 消息. While active, the
 *     session body is the three-column mailbox: nav (收件箱 / 发件箱 /
 *     联系人), message list, detail / composer. The label carries the unread
 *     count when there is one.
 *  2. `settings.section` (list) — a 「消息信箱 / Messages」 page in Settings:
 *     the msg9.io intro, the bound tenant, and every inbox this tenant has
 *     opened (address + unread/total counts).
 *
 * The store keeps the unread badge fresh with a low-frequency poll of
 * `/dsh-msg9/unread`.
 *
 * Registered by the same Loader entry as the host face, and only ever executed
 * in the browser cordis tree (the package's `./client` export).
 *
 * @module dsh-msg9-kit/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { Msg9Panel } from './Msg9Panel.tsx'
import { Msg9SettingsSection } from './Msg9SettingsSection.tsx'
import { L } from './locale.ts'
import { getMsg9Store, currentUnread } from './store.ts'
import { ensureMsg9Styles } from './theme.ts'
import { badgeText } from './view.ts'

export const name = 'msg9-kit'
export const inject = ['slots'] as const

/** The conversation view id (also used as the tab label key). */
export const MSG9_VIEW_ID = 'msg9'
/** The Settings section id (settings nav row + content key). */
export const MSG9_SETTINGS_ID = 'msg9-mailboxes'

// Re-exported so the built bundle can be driven directly by tests (and reused
// by another client plugin): the store, the components, and the bridge.
export { Msg9Panel } from './Msg9Panel.tsx'
export { Msg9SettingsSection } from './Msg9SettingsSection.tsx'
export { SetupView, externalizeLinks, LetterCard, findScrollParent, buildLetterTree, TenantNetwork } from './Msg9Panel.tsx'
export { agentPartCompliant, canOpen, canRemoveRecord, groupOf, PendingChips } from './Msg9SettingsSection.tsx'
export { filterRecipients, threadRows } from './view.ts'
export { createBridge } from './api.ts'
export { highlightReady, highlightCode } from './highlight.ts'
export { createMsg9Store, getMsg9Store, selectedWorkspace, currentUnread } from './store.ts'
export { ensureMsg9Styles, CLIENT_PLUGIN_ID, CSS_TAG_ID, M9_CSS, type StylesDocument } from './theme.ts'

/** Minimal service faces this plugin consumes (typed locally at the boundary). */
interface SlotsLike {
  inject(slot: string, cb: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
interface ClientCtxLike {
  logger(name: string): { info(...parts: unknown[]): void }
  effect(fn: () => (() => void) | void, name?: string): void
  slots: SlotsLike
}

export function apply(raw: Context): void {
  const ctx = raw as unknown as ClientCtxLike
  const log = ctx.logger('msg9-kit:client')
  const store = getMsg9Store()

  // The stylesheet is a package-owned <head> tag (T-15 mechanism: a React-
  // rendered <style> is untagged, so dsh's module loader books it for the next
  // materializing stranger and deletes it on that package's HMR — the panel
  // then degrades to unstyled markup). Idempotent + self-healing.
  ensureMsg9Styles()

  // The badge is useful before the view is ever opened.
  ctx.effect(() => store.start(), 'msg9-kit: unread poller')

  // The「消息」view tab: order 30 renders right after files (20); the header
  // tab strip lists conversation.view entries automatically, and the body
  // renders only the active entry (官方 `only: <active id>` 机制). The label
  // is re-resolved whenever the strip renders, so the unread count may lag a
  // poll behind — it is advisory, not a counter of record.
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view',
      id: MSG9_VIEW_ID,
      order: 30,
      label: () => {
        const state = store.getState()
        // The badge counts THIS workspace's inbox only. `unreadTotal` is the
        // account-wide sum across every provisioned inbox, so using it here
        // showed an unrelated number (e.g. 58 for one open tab).
        const n = currentUnread(state)
        const badge = badgeText(n)
        const base = badge ? L('消息（{n}）', 'Messages ({n})', { n }) : L('消息', 'Messages')
        // The mute state must be visible without opening the tab.
        return state.notifyPaused ? `${base}‖` : base
      },
      inject: () => ({ store }),
    },
    Msg9Panel,
  ))

  // Settings → 消息信箱: service intro, tenant, and every inbox opened here.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: MSG9_SETTINGS_ID,
      order: 50,
      label: () => L('消息信箱', 'Messages'),
      inject: () => ({ store }),
    },
    Msg9SettingsSection,
  ))

  log.info('msg9-kit browser face ready (conversation view + settings mailboxes)')
}
