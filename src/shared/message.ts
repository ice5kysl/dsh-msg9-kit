/**
 * Message helpers shared by the host and browser faces.
 *
 * msg9 carries the human text in `body.text` (a JSONB envelope that may hold
 * more keys), so both faces need the same tolerant reader.
 *
 * @module dsh-msg9-kit/message
 */

/** The body-carrying slice of a msg9 message. */
export interface MessageLike {
  body?: unknown
}

/**
 * The plain-text body of a msg9 message, or `''` when it carries none.
 * Accepts `{ text }`, a bare string, or anything else (treated as empty).
 */
export function bodyText(message: MessageLike | undefined | null): string {
  const body = message?.body
  if (typeof body === 'string') return body
  if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text
  }
  return ''
}

/** Collapse whitespace and clip to `limit` characters. */
export function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/** Mask a secret for display: `msg9_sk_abc…1234`. */
export function maskKey(key: string): string {
  if (key.length <= 14) return '***'
  return `${key.slice(0, 11)}…${key.slice(-4)}`
}
