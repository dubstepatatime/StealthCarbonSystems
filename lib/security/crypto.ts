/**
 * Cryptography helpers. Node's built-in primitives only.
 *
 * Secrets at rest are sealed with AES-256-GCM. Each record gets a fresh 96-bit
 * nonce and is bound to its owner through the additional authenticated data,
 * so a ciphertext copied onto another user's row will not decrypt.
 */
import 'server-only'
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

const VERSION = 'v1'
const b64 = (b: Buffer) => b.toString('base64url')

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.tokenKey(), 'stealth-carbon', purpose, 32))
}

/** Encrypt. `aad` names what the secret belongs to, e.g. `coinbase:<userId>`. */
export function seal(plaintext: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key('seal'), iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, b64(iv), b64(ct), b64(cipher.getAuthTag())].join('.')
}

/** Decrypt. Throws on any tampering, a wrong key or the wrong `aad`. */
export function open(sealed: string, aad: string): string {
  const [version, iv, ct, tag] = sealed.split('.')
  if (version !== VERSION || !iv || !ct || !tag) throw new Error('Unreadable sealed value')
  const decipher = createDecipheriv('aes-256-gcm', key('seal'), Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}

export const randomToken = (bytes = 32) => b64(randomBytes(bytes))
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const sha256Base64Url = (value: string) => createHash('sha256').update(value).digest('base64url')

/** Keyed hash for values we want to correlate but not store, such as client addresses. */
export const keyedHash = (value: string) => createHmac('sha256', key('hash')).update(value).digest('hex').slice(0, 32)

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}
