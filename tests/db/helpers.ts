import { createEmbeddedDb, type Db } from '@/lib/db/client'
import { user } from '@/lib/db/schema'

/** A fresh in-memory Postgres with every migration applied. */
export const freshDb = (): Promise<Db> => createEmbeddedDb()

export async function seedUser(db: Db, id = 'user_1', email = `${id}@example.test`): Promise<string> {
  await db.insert(user).values({ id, name: 'Test User', email })
  return id
}
