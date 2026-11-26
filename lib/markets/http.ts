/**
 * Outbound HTTP for market data. Three rules, enforced here so no provider can
 * forget them:
 *   1. only hosts on a fixed allow-list (nothing a request controls reaches fetch);
 *   2. a hard timeout and a response-size cap;
 *   3. the body is validated against a schema before anyone reads it.
 */
import type { z } from 'zod'

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'api.coinbase.com',
  'api.exchange.coinbase.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
])

const MAX_BYTES = 3 * 1024 * 1024

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

export interface FetchJsonOptions<T> {
  schema: z.ZodType<T>
  headers?: Record<string, string>
  timeoutMs?: number
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

export async function fetchJson<T>(url: string, { schema, headers, timeoutMs = 8_000, fetchImpl = fetch }: FetchJsonOptions<T>): Promise<T> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new UpstreamError('Host is not on the market-data allow-list', parsed.hostname)
  }
  let res: Response
  try {
    res = await fetchImpl(parsed, {
      headers: { Accept: 'application/json', ...headers },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : 'network error'
    throw new UpstreamError(`${parsed.hostname} ${reason}`, parsed.hostname)
  }
  if (!res.ok) throw new UpstreamError(`${parsed.hostname} answered ${res.status}`, parsed.hostname, res.status)

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new UpstreamError(`${parsed.hostname} response too large`, parsed.hostname, res.status)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new UpstreamError(`${parsed.hostname} response too large`, parsed.hostname, res.status)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new UpstreamError(`${parsed.hostname} did not return JSON`, parsed.hostname, res.status)
  }
  const result = schema.safeParse(json)
  if (!result.success) throw new UpstreamError(`${parsed.hostname} returned an unexpected shape`, parsed.hostname, res.status)
  return result.data
}
