/** The audit trail. Append-only (enforced in the database); metadata is redacted before it is written. */
import 'server-only'
import type { DbOrTx } from '@/lib/db/client'
import { auditEvents, type AuditActor } from '@/lib/db/schema'

const SENSITIVE = /token|secret|password|authorization|cookie|verifier|^code$|backup/i

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]))
  }
  return value
}

export interface AuditInput {
  userId?: string | null
  actor: AuditActor
  action: string
  summary: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ipHash?: string | null
}

export async function audit(db: DbOrTx, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    userId: e.userId ?? null,
    actor: e.actor,
    action: e.action,
    summary: e.summary.slice(0, 500),
    targetType: e.targetType,
    targetId: e.targetId,
    metadata: e.metadata ? (redact(e.metadata) as Record<string, unknown>) : undefined,
    ipHash: e.ipHash ?? null,
  })
}
