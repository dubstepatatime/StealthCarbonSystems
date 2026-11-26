import { NextResponse } from 'next/server'
import { getMarketSnapshot } from '@/lib/markets/service'

export const dynamic = 'force-dynamic'

/** Public, read-only, takes no input. The service caches, so traffic here never multiplies upstream calls. */
export async function GET() {
  try {
    return NextResponse.json(await getMarketSnapshot())
  } catch {
    return NextResponse.json({ error: 'Market data is unavailable.' }, { status: 503 })
  }
}
