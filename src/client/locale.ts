/**
 * Browser-side locale detection for dsh-msg9-kit.
 *
 * Resolution order: `navigator.language` (then `navigator.languages[0]`), with
 * the document language as a fallback; unknown tags resolve to English. Every
 * user-facing string is written in both languages at the call site:
 *
 *   L('中文原文', 'English original', { n: 3 })
 *
 * @module dsh-msg9-kit/client-locale
 */

import { localize, normalizeLocale, type Locale, type Vars } from '../shared/i18n.ts'

let cached: Locale | undefined

/** The effective browser locale (cached for the life of the page). */
export function browserLocale(): Locale {
  if (cached) return cached
  let raw = ''
  try {
    raw = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) || ''
    if (!raw && typeof document !== 'undefined') raw = document.documentElement?.lang ?? ''
  } catch {
    raw = ''
  }
  cached = normalizeLocale(raw)
  return cached
}

/** Localized string helper for browser copy. */
export function L(zh: string, en: string, vars?: Vars): string {
  return localize(browserLocale(), zh, en, vars)
}
