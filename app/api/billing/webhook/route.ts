import { getDb } from '@/lib/db/client'
import { handleWebhook } from '@/lib/billing/stripe'

export const dynamic = 'force-dynamic'

/** Stripe calls this. The signature over the raw body is the only thing trusted. */
export async function POST(request: Request) {
  const body = await request.text()
  if (body.length > 1_000_000) return new Response(null, { status: 413 })
  const status = await handleWebhook(await getDb(), body, request.headers.get('stripe-signature'))
  return new Response(null, { status })
}
