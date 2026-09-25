'use client'

import useSWR from 'swr'
import { Grid, Column } from '@carbon/react'
import { SegmentCard } from '@/components/dashboard/segment-card'
import { SEGMENTS, type Quote, type Segment } from '@/lib/markets'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type MarketsResponse = {
  quotes: Record<Segment, Quote[]>
  updatedAt: string
}

const ORDER: Segment[] = ['us', 'crypto', 'metals', 'global']

export function MarketOverview() {
  const { data, isLoading } = useSWR<MarketsResponse>('/api/markets', fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: false,
  })

  return (
    <Grid>
      {ORDER.map((seg) => (
        <Column key={seg} sm={4} md={4} lg={8}>
          <SegmentCard
            title={SEGMENTS[seg].label}
            description={SEGMENTS[seg].description}
            quotes={data?.quotes?.[seg] ?? []}
            loading={isLoading || !data}
          />
        </Column>
      ))}
    </Grid>
  )
}
