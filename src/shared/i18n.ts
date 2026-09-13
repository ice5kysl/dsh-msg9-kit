/**
 * Shared locale plumbing for dsh-msg9-kit.
 *
 * Pure helpers only (no node/dom globals) so the detection layer can live next
 * to whatever face needs it. Every user-facing string is written in both
 * languages at the call site:
 *
 *   L('中文原文', 'English original', { n: 3 })
 *
 * @module dsh-msg9-kit/i18n-core
 */

export type Locale = 'zh' | 'en'

export interface Vars {
  readonly [name: string]: string | number | undefined
}

/** Pick the localized template and substitute `{name}` placeholders. */
export function localize(locale: Locale, zh: string, en: string, vars?: Vars): string {
  const template = locale === 'zh' ? zh : en
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : raw,
  )
}

/** Normalize a raw tag ('zh-CN', 'en-US', …) to one of the supported locales. */
export function normalizeLocale(raw: string | undefined | null): Locale {
  const tag = (raw ?? '').toLowerCase()
  if (tag.startsWith('zh')) return 'zh'
  return 'en'
}
