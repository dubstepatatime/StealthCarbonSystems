import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { currentUser } from '@/lib/auth/session'
import './globals.scss'

export const metadata: Metadata = {
  title: 'Agentic Trading Desk',
  description: 'Live cross-market data and an AI trading agent that works inside limits you set.',
  robots: { index: true, follow: true },
}
export const viewport: Viewport = { colorScheme: 'dark', themeColor: '#161616' }
// Pages carry a per-request CSP nonce and per-user data, so nothing here is prerendered.
export const dynamic = 'force-dynamic'

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser().catch(() => null)
  return (
    <html lang="en">
      <body>
        <header className="cds--header" aria-label="Agentic Trading Desk">
          <a className="cds--skip-to-content" href="#main-content">Skip to main content</a>
          <Link className="cds--header__name" href="/">Agentic Trading Desk</Link>
          <div className="cds--header__global">
            <Link className="cds--btn cds--btn--primary cds--btn--lg" href={user ? '/desk' : '/sign-in'}>{user ? 'Open desk' : 'Sign in'}</Link>
          </div>
        </header>
        <main id="main-content" className="sc-main">{children}</main>
      </body>
    </html>
  )
}
