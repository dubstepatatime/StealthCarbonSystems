/**
 * The only way server code learns who is asking. Every page, action and route
 * that touches a person's data calls `requireUser()` itself; nothing relies on
 * the proxy or a layout having checked.
 */
import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { FRESH_SESSION_SECONDS, getAuth } from './server'

export interface CurrentUser {
  id: string
  email: string
  name: string
  twoFactorEnabled: boolean
  /** True when the session was created recently enough for sensitive actions. */
  fresh: boolean
}

export const currentUser = cache(async (): Promise<CurrentUser | null> => {
  const auth = await getAuth()
  const result = await auth.api.getSession({ headers: await headers() })
  if (!result) return null
  const created = new Date(result.session.createdAt).getTime()
  return {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    twoFactorEnabled: Boolean((result.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
    fresh: Date.now() - created < FRESH_SESSION_SECONDS * 1000,
  }
})

export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser()
  if (!user) redirect('/sign-in')
  return user
}
