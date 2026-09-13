/**
 * Ed25519 message signing for dsh-msg9-kit, implementing msg9's v1.3 identity
 * layer (`msg9-sig-v1`) byte-exactly — see `sdk/typescript/src/signing.ts`
 * and `backend/internal/identity` in the msg9 repo:
 *
 *   payload = "msg9-sig-v1\nfrom=<from>\nto=<to>\nts=<unix seconds>\n
 *              nonce=<nonce>\nidem=<idempotency key>\nbody_sha256=<hex>"
 *   headers = X-Msg9-Signature / X-Msg9-Timestamp / X-Msg9-Nonce
 *
 * A signed send MUST carry an Idempotency-Key (the server rejects it with
 * 40040 otherwise) — the plugin already sends one on every send.
 *
 * Keys are node:crypto Ed25519 keys; the 32-byte RFC 8032 seed is what the
 * state file persists (base64), the public half is registered with msg9 via
 * `PUT /api/v1/agent/signing-key` (first-time installs need only API-key
 * auth). Node built-ins only — no new dependency.
 *
 * @module dsh-msg9-kit/signing
 */

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, createPrivateKey, createPublicKey } from 'node:crypto'
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface SigningMaterial {
  /** base64 (standard) of the 32-byte Ed25519 seed — persisted in state. */
  seed: string
  /** base64 (standard) of the raw 32-byte public key — registered with msg9. */
  publicKey: string
}

/** Generate a fresh Ed25519 key pair (seed + public key, base64). */
export function generateSigningMaterial(): SigningMaterial {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string }
  return {
    seed: Buffer.from(jwk.d!, 'base64url').toString('base64'),
    publicKey: Buffer.from(jwk.x!, 'base64url').toString('base64'),
  }
}

/** The raw 32-byte public key (base64) derived from a stored seed (base64). */
export function publicKeyFromSeed(seedBase64: string): string {
  const jwk = createPublicKey(privateKeyFromSeed(seedBase64)).export({ format: 'jwk' }) as { x?: string }
  return Buffer.from(jwk.x!, 'base64url').toString('base64')
}

function privateKeyFromSeed(seedBase64: string) {
  const seed = Buffer.from(seedBase64, 'base64')
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

/** The four wire headers of a signed send, per msg9-sig-v1. */
export function buildSignatureHeaders(options: {
  from: string
  to: string
  /** The EXACT body bytes that will be sent (JSON string, verbatim). */
  body: string
  seedBase64: string
  idempotencyKey: string
  timestamp?: number
  nonce?: string
}): Record<string, string> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const nonce = options.nonce ?? randomBytes(16).toString('hex')
  const bodySha256 = createHash('sha256').update(options.body, 'utf8').digest('hex')
  const payload = [
    'msg9-sig-v1',
    `from=${options.from}`,
    `to=${options.to}`,
    `ts=${timestamp}`,
    `nonce=${nonce}`,
    `idem=${options.idempotencyKey}`,
    `body_sha256=${bodySha256}`,
  ].join('\n')
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKeyFromSeed(options.seedBase64)).toString('base64')
  return {
    'X-Msg9-Signature': signature,
    'X-Msg9-Timestamp': String(timestamp),
    'X-Msg9-Nonce': nonce,
    'Idempotency-Key': options.idempotencyKey,
  }
}
