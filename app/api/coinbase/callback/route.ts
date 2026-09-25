import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = url.origin
  const code = url.searchParams.get('code')

  const clientId = process.env.COINBASE_CLIENT_ID
  const clientSecret = process.env.COINBASE_CLIENT_SECRET

  if (!code || !clientId || !clientSecret) {
    return NextResponse.redirect(`${origin}/?coinbase=error`)
  }

  try {
    const tokenRes = await fetch('https://login.coinbase.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${origin}/api/coinbase/callback`,
      }),
    })

    if (!tokenRes.ok) {
      return NextResponse.redirect(`${origin}/?coinbase=error`)
    }

    const token = await tokenRes.json()
    const store = await cookies()
    store.set('coinbase_access_token', token.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: typeof token.expires_in === 'number' ? token.expires_in : 3600,
    })

    return NextResponse.redirect(`${origin}/?coinbase=connected`)
  } catch {
    return NextResponse.redirect(`${origin}/?coinbase=error`)
  }
}
