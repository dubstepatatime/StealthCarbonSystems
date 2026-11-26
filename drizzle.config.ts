import { defineConfig } from 'drizzle-kit'

// `drizzle-kit generate` only reads the schema; it never connects. The URL is
// used by `drizzle-kit studio` and similar commands when you run them yourself.
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/unused' },
  strict: true,
})
