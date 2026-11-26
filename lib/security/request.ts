import 'server-only'
import { keyedHash } from './crypto'

/**
 * The client address as the platform reports it. Only headers set by the
 * hosting edge are trusted; a client-supplied X-Forwarded-For is read last and
 * only its right-most hop, which is the one our own proxy appended.
 */
export function clientIp(headers: Headers): string {
  const direct = headers.get('x-vercel-forwarded-for') ?? headers.get('x-real-ip')
  if (direct) return direct.split(',')[0]!.trim()
  const xff = headers.get('x-forwarded-for')
  return xff ? xff.split(',').at(-1)!.trim() : 'unknown'
}

export const ipHash = (headers: Headers) => keyedHash(clientIp(headers))

/** True when a state-changing request comes from our own origin. */
export function sameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get('origin')
  if (origin) return origin === appOrigin
  const site = request.headers.get('sec-fetch-site')
  return site === 'same-origin'
}
