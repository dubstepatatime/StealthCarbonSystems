'use client'

import { useEffect, useState } from 'react'
import { CARET, direction, formatPercent, formatPrice, formatTime } from '@/lib/format'
import { SEGMENT_META, SEGMENT_ORDER, type MarketSnapshot, type Quote } from '@/lib/markets/types'

const REFRESH_MS = 30_000

function Spark({ values, dir }: { values: number[]; dir: 'up' | 'down' | 'flat' }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 72).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(' ')
  return (
    <svg className={`sc-spark sc-${dir}`} width="72" height="24" viewBox="0 0 72 24" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function Row({ q }: { q: Quote }) {
  const dir = direction(q.changePercent)
  return (
    <div className="sc-row">
      <div>
        <span className="sc-row__name">{q.name}</span>
        <span className="sc-row__symbol">{q.symbol}</span>
      </div>
      <div className="sc-figs">
        <Spark values={q.spark} dir={dir} />
        <span className="sc-fig">{formatPrice(q.price, q.decimals)}</span>
        <span className={`sc-fig sc-${dir}`}>
          <span aria-hidden="true">{CARET[dir]} </span>
          {formatPercent(q.changePercent)}
        </span>
      </div>
    </div>
  )
}

export function Markets({ initial }: { initial: MarketSnapshot | null }) {
  const [data, setData] = useState(initial)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/markets', { cache: 'no-store' })
        if (!res.ok) throw new Error()
        const json = (await res.json()) as MarketSnapshot
        if (alive) {
          setData(json)
          setFailed(false)
        }
      } catch {
        if (alive) setFailed(true)
      }
    }
    if (!initial) void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [initial])

  if (!data) return <p className="sc-note">{failed ? 'Market data is unavailable right now.' : 'Loading live markets…'}</p>
  return (
    <>
      <div className="sc-grid">
        {SEGMENT_ORDER.map((segment) => {
          const quotes = data.segments[segment]
          const open = quotes.filter((q) => q.marketState === 'open').length
          return (
            <section key={segment} className="sc-tile" aria-label={SEGMENT_META[segment].label}>
              <div className="sc-tile__head">
                <div>
                  <h3 className="sc-tile__title">{SEGMENT_META[segment].label}</h3>
                  <p className="sc-tile__desc">{SEGMENT_META[segment].description}</p>
                </div>
                <span className={`cds--tag cds--tag--sm ${open ? 'cds--tag--green' : 'cds--tag--cool-gray'}`}>
                  <span className="cds--tag__label">{open ? `${open} open` : 'closed'}</span>
                </span>
              </div>
              <div>{quotes.map((q) => <Row key={q.id} q={q} />)}</div>
            </section>
          )
        })}
      </div>
      <p className="sc-legal" role="status">
        Updated {formatTime(data.generatedAt)}, refreshes every 30s. Crypto is real time from Coinbase; indices and futures may be delayed up to 15 min.
        {failed ? ' Last refresh failed; showing the previous data.' : ''}
      </p>
    </>
  )
}
