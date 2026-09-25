import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

interface CoinbaseAccount {
  name: string
  currency: string
  balance: { amount: string; currency: string }
}

export async function GET() {
  const store = await cookies()
  const token = store.get('coinbase_access_token')?.value
  const configured = Boolean(process.env.COINBASE_CLIENT_ID)

  if (!token) {
    return NextResponse.json({ connected: false, configured })
  }

  try {
    const res = await fetch('https://api.coinbase.com/v2/accounts', {
      headers: {
        Authorization: `Bearer ${token}`,
        'CB-VERSION': '2024-01-01',
      },
      cache: 'no-store',
    })

    if (!res.ok) {
      return NextResponse.json({ connected: false, configured })
    }

    const json = await res.json()
    const accounts: CoinbaseAccount[] = (json?.data ?? [])
      .filter((a: CoinbaseAccount) => Number(a.balance?.amount) > 0)
      .slice(0, 6)
      .map((a: CoinbaseAccount) => ({
        name: a.name,
        currency: a.currency,
        balance: a.balance,
      }))

    return NextResponse.json({ connected: true, configured, accounts })
  } catch {
    return NextResponse.json({ connected: false, configured })
  }
}
