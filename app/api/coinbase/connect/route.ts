import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const clientId = process.env.COINBASE_CLIENT_ID
  const origin = new URL(request.url).origin

  if (!clientId) {
    // Credentials not configured yet — tell the client so it can surface setup guidance.
    return NextResponse.redirect(`${origin}/?coinbase=unconfigured`)
  }

  const redirectUri = `${origin}/api/coinbase/callback`
  const authUrl = new URL('https://login.coinbase.com/oauth2/auth')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', 'wallet:accounts:read wallet:user:read')

  return NextResponse.redirect(authUrl.toString())
}
