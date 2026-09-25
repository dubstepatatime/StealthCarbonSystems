import { NextResponse } from 'next/server'
import { getAllQuotes } from '@/lib/markets'

export const dynamic = 'force-dynamic'

export async function GET() {
  const data = await getAllQuotes()
  return NextResponse.json({ quotes: data, updatedAt: new Date().toISOString() })
}
