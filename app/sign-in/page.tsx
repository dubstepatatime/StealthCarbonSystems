import { redirect } from 'next/navigation'
import { SignInForm } from '@/components/sign-in-form'
import { currentUser } from '@/lib/auth/session'

export const metadata = { title: 'Sign in — Agentic Trading Desk', robots: { index: false } }

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  if (await currentUser()) redirect('/desk')
  const { mode } = await searchParams
  return (
    <section className="sc-section">
      <div className="sc-wrap">
        <SignInForm initialMode={mode === 'create' ? 'create' : 'sign-in'} />
      </div>
    </section>
  )
}
