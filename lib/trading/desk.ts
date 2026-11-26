/**
 * The desk: one shared read of the markets that every agent uses.
 *
 * It is built from market data only and never sees anything about a user.
 * The numbers come from the rules in ./signals. When an AI model is
 * configured it may tilt each conviction by a bounded amount and writes the
 * narrative; if it is missing, slow or returns nonsense, the desk falls back
 * to the rules alone and says so.
 */
import 'server-only'
import { generateText, Output } from 'ai'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '@/lib/db/client'
import { deskRuns } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { INSTRUMENTS } from '@/lib/markets/instruments'
import { getDailyHistory } from '@/lib/markets/service'
import type { DailySeries, Segment } from '@/lib/markets/types'
import { computeFeatures, type Features } from './indicators'
import { TRADABLE_PRODUCTS } from './limits'
import { boundRegime, buildAssetSignal, quantRegime, quantScore, signalWord } from './signals'
import type { AssetSignal, Regime, SignalWord } from './types'

export interface DeskReport {
  asOf: string
  source: 'ai+quant' | 'quant'
  regime: Regime
  narrative: string
  segments: { segment: Segment; score: number; word: SignalWord }[]
  signals: AssetSignal[]
}

/** How long a desk report is reused before a new one is built. */
export const DESK_TTL_MS = 4 * 3_600_000

const featuresOf = (s: DailySeries | undefined): Features | null => (s ? computeFeatures(s.c.map((c, i) => ({ t: s.t[i]!, o: c, h: c, l: c, c, v: 0 }))) : null)

const aiSchema = z.object({
  regime: z.enum(['risk_on', 'neutral', 'risk_off']),
  narrative: z.string().max(700),
  assets: z.array(z.object({ productId: z.enum(TRADABLE_PRODUCTS), view: z.number().min(-1).max(1), rationale: z.string().max(240) })).max(TRADABLE_PRODUCTS.length),
})

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`)

async function askModel(lines: string[], regime: Regime): Promise<z.infer<typeof aiSchema> | null> {
  if (!env.aiEnabled()) return null
  try {
    const { output } = await generateText({
      model: env.aiModel(),
      output: Output.object({ schema: aiSchema }),
      abortSignal: AbortSignal.timeout(45_000),
      system:
        'You are a cross-market analyst. You are given only computed statistics. Return a market regime, a short plain narrative with no promises or advice, and for each crypto product a view from -1 (strongly negative) to 1 (strongly positive) with a one-sentence reason. Be conservative: when the evidence is mixed, stay near zero.',
      prompt: `Rules-based regime: ${regime}\n\n${lines.join('\n')}`,
    })
    return output
  } catch {
    return null
  }
}

export async function buildDeskReport(history: Record<string, DailySeries>, now = new Date()): Promise<DeskReport> {
  const features = new Map<string, Features>()
  for (const i of INSTRUMENTS) {
    const f = featuresOf(history[i.id])
    if (f) features.set(i.id, f)
  }
  const score = (id: string) => (features.has(id) ? quantScore(features.get(id)!) : null)
  const equityScores = ['spx', 'ixic', 'ftse', 'dax', 'n225', 'hsi'].map(score).filter((v): v is number => v !== null)
  const baseRegime = quantRegime({ equityScores, vix: features.get('vix')?.last ?? null })

  const lines = INSTRUMENTS.filter((i) => features.has(i.id)).map((i) => {
    const f = features.get(i.id)!
    return `${i.name} (${i.symbol}, ${i.segment}): 30-session return ${pct(f.ret30d)}, 7-session ${pct(f.ret7d)}, vs 50-session mean ${pct(f.sma50Dist)}, RSI ${f.rsi14?.toFixed(0) ?? 'n/a'}, from 90-session high ${pct(f.drawdown90d)}, rules score ${quantScore(f)}`
  })
  const ai = await askModel(lines, baseRegime)

  const signals: AssetSignal[] = []
  for (const productId of TRADABLE_PRODUCTS) {
    const instrument = INSTRUMENTS.find((i) => i.symbol === productId)
    const f = instrument ? features.get(instrument.id) : undefined
    if (!f) continue // no history, no signal: the allocator treats a missing product as no position
    const view = ai?.assets.find((a) => a.productId === productId)
    signals.push(buildAssetSignal(productId, f, view ? { view: view.view, rationale: view.rationale } : null))
  }

  const segments = (['us', 'global', 'crypto', 'metals'] as Segment[]).map((segment) => {
    const scores = INSTRUMENTS.filter((i) => i.segment === segment && i.id !== 'vix').map((i) => score(i.id)).filter((v): v is number => v !== null)
    const mean = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : 0
    return { segment, score: mean, word: signalWord(mean) }
  })
  const regime = boundRegime(baseRegime, ai?.regime ?? null)
  return {
    asOf: now.toISOString(),
    source: ai ? 'ai+quant' : 'quant',
    regime,
    narrative: ai?.narrative ?? `Rules-based read: the regime is ${regime.replace('_', '-')}. ${segments.map((s) => `${s.segment} ${s.word}`).join(', ')}.`,
    segments,
    signals,
  }
}

/** The current desk report: the stored one if it is fresh, otherwise a new one. */
export async function getDeskReport(db: Db, now = new Date()): Promise<{ id: string; report: DeskReport }> {
  const [latest] = await db.select().from(deskRuns).orderBy(desc(deskRuns.createdAt)).limit(1)
  if (latest && now.getTime() - latest.createdAt.getTime() < DESK_TTL_MS) return { id: latest.id, report: latest.report as DeskReport }
  const report = await buildDeskReport(await getDailyHistory(), now)
  const [row] = await db.insert(deskRuns).values({ source: report.source, regime: report.regime, report, marketAsOf: now, models: report.source === 'ai+quant' ? { orchestrator: env.aiModel() } : undefined }).returning({ id: deskRuns.id })
  return { id: row!.id, report }
}
