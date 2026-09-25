'use client'

import { Tile, Tag, SkeletonText } from '@carbon/react'
import type { Quote } from '@/lib/markets'

function formatPrice(q: Quote) {
  if (q.price === null) return '—'
  return q.price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function ChangeCell({ q }: { q: Quote }) {
  if (q.changePercent === null) {
    return <span className="quote-row__change quote-row__change--flat">n/a</span>
  }
  const up = q.changePercent > 0
  const down = q.changePercent < 0
  const cls = up
    ? 'quote-row__change--up'
    : down
      ? 'quote-row__change--down'
      : 'quote-row__change--flat'
  const sign = up ? '+' : ''
  return (
    <span className={`quote-row__change ${cls}`}>
      {sign}
      {q.changePercent.toFixed(2)}%
    </span>
  )
}

export function SegmentCard({
  title,
  description,
  quotes,
  loading,
}: {
  title: string
  description: string
  quotes: Quote[]
  loading: boolean
}) {
  return (
    <Tile className="segment-card">
      <div className="segment-card__head">
        <div>
          <div className="segment-card__title">{title}</div>
          <div className="segment-card__desc">{description}</div>
        </div>
        <Tag type="cool-gray" size="sm">
          {loading ? '···' : `${quotes.length} assets`}
        </Tag>
      </div>

      {loading ? (
        <SkeletonText paragraph lineCount={3} />
      ) : (
        <div>
          {quotes.map((q) => (
            <div className="quote-row" key={q.symbol}>
              <div>
                <span className="quote-row__name">{q.name}</span>
                <span className="quote-row__symbol">{q.symbol}</span>
              </div>
              <div className="quote-row__figures">
                <span className="quote-row__price">{formatPrice(q)}</span>
                <ChangeCell q={q} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Tile>
  )
}
