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
import { getMsg9Store } from './store.ts'
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
export { SetupView } from './Msg9Panel.tsx'
export { createBridge } from './api.ts'
export { highlightReady } from './highlight.ts'
export { createMsg9Store, getMsg9Store, selectedWorkspace } from './store.ts'

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
        const badge = badgeText(store.getState().unreadTotal)
        const base = badge
          ? L('消息（{n}）', 'Messages ({n})', { n: store.getState().unreadTotal })
          : L('消息', 'Messages')
        // The mute state must be visible without opening the tab.
        return store.getState().notifyPaused ? `${base}‖` : base
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
