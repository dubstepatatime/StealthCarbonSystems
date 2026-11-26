/**
 * Database access.
 *
 * Production talks to PostgreSQL through node-postgres (DATABASE_URL).
 * Development and tests run PGlite — real Postgres compiled to WebAssembly,
 * in this process — so the same SQL and the same migrations run everywhere
 * with nothing to install. PGlite is never used in production: without
 * DATABASE_URL a production server refuses to start its data layer.
 */
import 'server-only'
import path from 'node:path'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
/** A transaction handle has the same query surface as the database. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DbOrTx = Db | Tx

export const MIGRATIONS_FOLDER = path.join(process.cwd(), 'drizzle')

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigError'
  }
}

async function connectPostgres(url: string): Promise<Db> {
  const { Pool } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new Pool({
    connectionString: url,
    // Serverless instances are many and short-lived: keep each one's footprint small.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  })
  pool.on('error', () => {
    // An idle client failing must not crash the process; the next query reconnects.
  })
  return drizzle({ client: pool, schema }) as unknown as Db
}

/** An embedded database with all migrations applied. `dataDir` omitted means in-memory. */
export async function createEmbeddedDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  if (dataDir) (await import('node:fs')).mkdirSync(path.dirname(dataDir), { recursive: true })
  const client = dataDir ? new PGlite(dataDir) : new PGlite()
  const db = drizzle({ client, schema })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return db as unknown as Db
}

const globalDb = globalThis as unknown as { __scDb?: Promise<Db> }

/** The process-wide database handle. Safe to call from anywhere on the server. */
export function getDb(): Promise<Db> {
  if (!globalDb.__scDb) {
    const url = process.env.DATABASE_URL
    if (url) {
      globalDb.__scDb = connectPostgres(url)
    } else if (process.env.NODE_ENV === 'production') {
      globalDb.__scDb = Promise.reject(new DatabaseConfigError('DATABASE_URL is not set. The embedded database is for development only.'))
    } else {
      globalDb.__scDb = createEmbeddedDb(process.env.PGLITE_DATA_DIR ?? path.join(process.cwd(), '.data', 'pglite'))
    }
    // Do not cache a failed connection: the next call should try again.
    globalDb.__scDb.catch(() => {
      globalDb.__scDb = undefined
    })
  }
  return globalDb.__scDb
}

export { schema }
