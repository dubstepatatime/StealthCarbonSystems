import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function POST() {
  const store = await cookies()
  store.delete('coinbase_access_token')
  return NextResponse.json({ connected: false })
}
