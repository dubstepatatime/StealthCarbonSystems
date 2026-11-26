/**
 * Live smoke test for the market-data layer. Calls the real sources.
 * Run: pnpm tsx scripts/smoke-markets.ts
 */
import { getDailyHistory, getMarketSnapshot } from '../lib/markets/service'
import { fetchProductSpecs, fetchTopOfBook } from '../lib/markets/providers/coinbase'
import { computeFeatures } from '../lib/trading/indicators'
import { quantScore } from '../lib/trading/signals'

const snapshot = await getMarketSnapshot()
for (const [segment, quotes] of Object.entries(snapshot.segments)) {
  console.log(`\n${segment}`)
  for (const q of quotes) {
    const pct = q.changePercent === null ? '—' : `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`
    console.log(`  ${q.name.padEnd(20)} ${q.symbol.padEnd(18)} ${String(q.price ?? '—').padStart(12)} ${pct.padStart(8)}  ${q.marketState.padEnd(7)} ${q.source.padEnd(20)} spark:${String(q.spark.length).padStart(2)} ${q.asOf ?? ''} ${q.error ?? ''}`)
  }
}
console.log('\nmacro', snapshot.macro.map((q) => `${q.name} ${q.price}`).join(' | '))
console.log('sources', JSON.stringify(snapshot.sources))

const history = await getDailyHistory()
console.log('\nhistory series:', Object.keys(history).length)
for (const id of ['btc', 'eth', 'sol', 'paxg', 'spx', 'vix', 'gold', 'silver']) {
  const s = history[id]
  if (!s) { console.log(`  ${id}: missing`); continue }
  const f = computeFeatures(s.c.map((c, i) => ({ t: s.t[i]!, o: c, h: c, l: c, c, v: 0 })))
  console.log(`  ${id.padEnd(7)} n=${String(s.c.length).padStart(3)} last=${s.c.at(-1)} quant=${f ? quantScore(f) : 'n/a'} rsi=${f?.rsi14?.toFixed(0)} ret30=${f?.ret30d != null ? (f.ret30d * 100).toFixed(1) + '%' : '—'}`)
}
const specs = await fetchProductSpecs(['BTC-USD', 'ETH-USD', 'SOL-USD', 'PAXG-USD'])
console.log('\nspecs', Object.values(specs).map((s) => `${s.productId} tradable=${s.tradable} inc=${s.baseIncrement}/${s.priceIncrement} min=${s.quoteMinSize}`).join(' | '))
const book = await fetchTopOfBook('BTC-USD')
console.log('book BTC-USD', book.bid.toFixed(), book.ask.toFixed(), book.asOf.toISOString())
