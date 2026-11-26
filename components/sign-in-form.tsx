'use client'

import { useState, type FormEvent } from 'react'
import { authClient } from '@/lib/auth/client'

type Mode = 'sign-in' | 'create' | 'code'
const MIN_PASSWORD = 12

export function SignInForm({ initialMode }: { initialMode: 'sign-in' | 'create' }) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const get = (k: string) => String(form.get(k) ?? '')
    setBusy(true)
    setError(null)
    try {
      if (mode === 'code') {
        const { error } = await authClient.twoFactor.verifyTotp({ code: get('code').replace(/\s/g, '') })
        if (error) return setError('That code was not accepted.')
      } else if (mode === 'create') {
        const { error } = await authClient.signUp.email({ name: get('name'), email: get('email'), password: get('password') })
        if (error) return setError(error.message ?? 'Could not create the account.')
      } else {
        const { data, error } = await authClient.signIn.email({ email: get('email'), password: get('password') })
        // One message for every failure, so the form does not reveal which emails have accounts.
        if (error) return setError('Email or password is incorrect.')
        if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return setMode('code')
      }
      window.location.assign('/desk')
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="sc-form" onSubmit={submit} noValidate={false}>
      <h1 className="sc-h2">{mode === 'create' ? 'Create your account' : mode === 'code' ? 'Enter your code' : 'Sign in'}</h1>
      {mode === 'code' ? (
        <div className="sc-field">
          <label htmlFor="code">6-digit code from your authenticator app</label>
          <input className="sc-input" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
        </div>
      ) : (
        <>
          {mode === 'create' && (
            <div className="sc-field">
              <label htmlFor="name">Name</label>
              <input className="sc-input" id="name" name="name" autoComplete="name" maxLength={80} required />
            </div>
          )}
          <div className="sc-field">
            <label htmlFor="email">Email</label>
            <input className="sc-input" id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          </div>
          <div className="sc-field">
            <label htmlFor="password">Password{mode === 'create' ? ` (at least ${MIN_PASSWORD} characters)` : ''}</label>
            <input className="sc-input" id="password" name="password" type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} minLength={mode === 'create' ? MIN_PASSWORD : 1} maxLength={128} required />
          </div>
        </>
      )}
      {error && <p className="sc-note sc-note--error" role="alert">{error}</p>}
      <div className="sc-inline">
        <button className="cds--btn cds--btn--primary" type="submit" disabled={busy}>{busy ? 'Working…' : mode === 'create' ? 'Create account' : mode === 'code' ? 'Verify' : 'Sign in'}</button>
        {mode !== 'code' && (
          <button className="cds--btn cds--btn--ghost" type="button" onClick={() => { setError(null); setMode(mode === 'create' ? 'sign-in' : 'create') }}>
            {mode === 'create' ? 'I have an account' : 'Create an account'}
          </button>
        )}
      </div>
      {mode === 'create' && <p className="sc-legal">You must be 18 or older and in the United States. New accounts start in paper trading. Automated trading can lose money.</p>}
    </form>
  )
}
