/**
 * Pure presentation helpers for the msg9 panel.
 *
 * No React and no store access, so the panel's copy and formatting rules stay
 * unit-testable in plain node.
 *
 * @module dsh-msg9-kit/client-view
 */

import { bodyText, truncate } from '../shared/message.ts'
import type { ContactRow, DirectoryAgentRow, MessageRow, WorkspaceView } from '../shared/types.ts'
import { L } from './locale.ts'

/** Short, one-line preview of a message. */
export function previewOf(message: MessageRow, limit = 90): string {
  const text = bodyText(message)
  if (text) return truncate(text, limit)
  if (message.subject) return truncate(message.subject, limit)
  return L('（空消息）', '(empty message)')
}

/** Full body of a message, preserving line breaks. */
export function fullBody(message: MessageRow): string {
  const text = bodyText(message)
  return text || L('（空消息）', '(empty message)')
}

/** True when the message has not been read yet. */
export function isUnread(message: MessageRow): boolean {
  return !message.read_at
}

/** Localized date-time for a msg9 timestamp. */
export function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return date.toISOString()
  }
}

/** Label of an address-book row: alias when present, address otherwise. */
export function contactLabel(contact: ContactRow): string {
  return contact.alias?.trim() || contact.contact
}

/** Sidebar badge text: nothing at zero, `99+` when it overflows. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  return count > 99 ? '99+' : String(Math.trunc(count))
}

/** Human label for a workspace row. */
export function workspaceLabel(workspace: WorkspaceView): string {
  const address = workspace.address ?? L('未开通收件箱', 'no inbox yet')
  return `${workspace.title} · ${address}`
}

/** Filter the address book by a literal, case-insensitive query. */
export function filterContacts(contacts: ContactRow[], query: string): ContactRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return contacts
  return contacts.filter((contact) => {
    const haystack = `${contact.alias ?? ''} ${contact.contact} ${contact.notes ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/** Display name of a directory row: profile name, else the bare address. */
export function agentLabel(agent: DirectoryAgentRow): string {
  return agent.display_name?.trim() || agent.address
}

/** Folder chips of the inbox tab. `pending` filters client-side (not a server folder). */
export const FOLDERS = ['all', 'unread', 'read', 'pending'] as const

/** Localized folder chip label. */
export function folderLabel(folder: (typeof FOLDERS)[number]): string {
  if (folder === 'unread') return L('未读', 'Unread')
  if (folder === 'read') return L('已读', 'Read')
  if (folder === 'pending') return L('待处理', 'Pending')
  return L('全部', 'All')
}

/** Closed-loop label of a processed message: who handled it. */
export function processedLabel(message: MessageRow): string {
  if (!message.processed_by) return ''
  return message.processed_by === 'human' ? L('人已处理', 'Handled by you') : L('Agent 已处理', 'Handled by agent')
}
