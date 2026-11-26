/** The paper broker: real quotes and product rules from Coinbase's public API, simulated fills. Needs no account. */
import 'server-only'
import { fetchProductSpecs, fetchSpotProducts, fetchTopOfBook } from '@/lib/markets/providers/coinbase'
import { PAPER_TAKER_FEE_BPS, simulateFill, type Broker } from './broker'
import { bpsOf } from './money'
import type { TopOfBook } from './types'

export function createPaperBroker(): Broker {
  const books: Record<string, TopOfBook> = {}
  return {
    ledger: 'paper',
    getProducts: (ids) => fetchProductSpecs(ids),
    async getTopOfBook(ids) {
      const products = await fetchSpotProducts(ids)
      await Promise.all(
        ids.map(async (id) => {
          const pct = Number(products.get(id)?.price_percentage_change_24h)
          books[id] = await fetchTopOfBook(id, {}, Number.isFinite(pct) ? pct : null)
        }),
      )
      return { ...books }
    },
    getFeeRate: async () => bpsOf(PAPER_TAKER_FEE_BPS),
    async placeOrder({ clientOrderId, ticket }) {
      const book = books[ticket.productId]
      if (!book) return { status: 'failed', reason: 'No quote.' }
      const fill = simulateFill(ticket, book, bpsOf(PAPER_TAKER_FEE_BPS))
      return fill ? { status: 'filled', exchangeOrderId: `paper-${clientOrderId}`, fill } : { status: 'cancelled', exchangeOrderId: null, reason: 'No price inside the collar.' }
    },
  }
}
