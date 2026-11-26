/**
 * Runs before every page. Two jobs:
 *  1. a strict Content-Security-Policy with a fresh nonce per request, plus the
 *     other security headers;
 *  2. sending signed-out visitors away from /desk early. This is a convenience
 *     only: /desk and every action verify the session themselves.
 */
import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const dev = process.env.NODE_ENV !== 'production'
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Development tooling injects inline styles; production allows only our stylesheet and nonce.
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    // Checkout and the Coinbase consent page are reached by server redirect, so forms only post home.
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ')

  if (request.nextUrl.pathname.startsWith('/desk') && !getSessionCookie(request, { cookiePrefix: 'sc' })) {
    return NextResponse.redirect(new URL('/sign-in', request.url))
  }
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', csp)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [{ source: '/((?!api|_next/static|_next/image|fonts|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }],
}
