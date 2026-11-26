'use client'

import { useState, type FormEvent } from 'react'
import { authClient } from '@/lib/auth/client'

/** Turn on two-factor authentication: confirm the password, add the key to an authenticator app, prove a code. */
export function TwoFactorSetup() {
  const [setup, setSetup] = useState<{ secret: string; backupCodes: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error } = await authClient.twoFactor.enable({ password: String(new FormData(e.currentTarget).get('password') ?? '') })
    setBusy(false)
    if (error || !data || !('totpURI' in data)) return setError('Password was not accepted.')
    const secret = new URL(data.totpURI).searchParams.get('secret') ?? ''
    setSetup({ secret, backupCodes: data.backupCodes })
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await authClient.twoFactor.verifyTotp({ code: String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '') })
    setBusy(false)
    if (error) return setError('That code was not accepted.')
    window.location.assign('/desk?msg=2fa-on')
  }

  if (!setup) {
    return (
      <form className="sc-form" onSubmit={start}>
        <div className="sc-field">
          <label htmlFor="tf-password">Confirm your password to begin</label>
          <input className="sc-input" id="tf-password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {error && <p className="sc-note sc-note--error" role="alert">{error}</p>}
        <div><button className="cds--btn cds--btn--tertiary cds--btn--sm" disabled={busy}>Set up two-factor</button></div>
      </form>
    )
  }
  return (
    <form className="sc-form" onSubmit={verify}>
      <p className="sc-body">Add this key to your authenticator app (choose "enter a setup key", time-based):</p>
      <p className="sc-fig">{setup.secret}</p>
      <p className="sc-body">Save these one-time backup codes somewhere safe. They are shown once.</p>
      <p className="sc-fig">{setup.backupCodes.join('  ')}</p>
      <div className="sc-field">
        <label htmlFor="tf-code">6-digit code from the app</label>
        <input className="sc-input" id="tf-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      </div>
      {error && <p className="sc-note sc-note--error" role="alert">{error}</p>}
      <div><button className="cds--btn cds--btn--primary cds--btn--sm" disabled={busy}>Turn on two-factor</button></div>
    </form>
  )
}
