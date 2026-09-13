/**
 * Host-side (node) locale detection for dsh-msg9-kit.
 *
 * Resolution order:
 *   1. `MSG9KIT_LOCALE=zh|en` environment variable (explicit override);
 *   2. `LC_ALL` / `LANG` starting with `zh` → Chinese;
 *   3. default: English.
 *
 * Resolved once per process (host tools are registered at startup).
 *
 * @module dsh-msg9-kit/host-locale
 */

import { localize, normalizeLocale, type Locale, type Vars } from '../shared/i18n.ts'

let cached: Locale | undefined

/** Resolve the effective locale for this process (cached). */
export function detectLocale(): Locale {
  if (cached) return cached
  const override = (process.env.MSG9KIT_LOCALE ?? '').toLowerCase()
  if (override === 'zh' || override === 'en') {
    cached = override as Locale
    return cached
  }
  cached = normalizeLocale(process.env.LC_ALL || process.env.LANG || '')
  return cached
}

/** Localized string helper for host-side copy. */
export function L(zh: string, en: string, vars?: Vars): string {
  return localize(detectLocale(), zh, en, vars)
}
