/**
 * Apply SQL migrations to the database in DATABASE_URL.
 * Run before deploying a version that changes the schema: `pnpm db:migrate`.
 */
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
    console.log('Migrations applied.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
