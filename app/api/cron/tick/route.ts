import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { env } from '@/lib/env'
import { safeEqual } from '@/lib/security/crypto'
import { getDeskReport } from '@/lib/trading/desk'
import { claimDueAgents, expireProposals, platformHalted, runAgentTick } from '@/lib/trading/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The scheduler entry point. Only the platform's cron, which holds CRON_SECRET, may call it. */
export async function GET(request: Request) {
  const sent = request.headers.get('authorization') ?? ''
  if (!safeEqual(sent, `Bearer ${env.cronSecret()}`)) return new Response(null, { status: 401 })
  const db = await getDb()
  await expireProposals(db)
  if (await platformHalted(db)) return NextResponse.json({ halted: true })
  const desk = await getDeskReport(db)
  const deadline = Date.now() + 45_000
  const outcomes: Record<string, number> = {}
  for (const id of await claimDueAgents(db, 25)) {
    if (Date.now() > deadline) break // unclaimed work is picked up next time; leases expire on their own
    const { outcome } = await runAgentTick(db, id, desk)
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  return NextResponse.json({ regime: desk.report.regime, outcomes })
}
