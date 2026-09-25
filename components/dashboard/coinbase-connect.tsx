'use client'

import useSWR from 'swr'
import { Tile, Button, Tag, InlineNotification, SkeletonText } from '@carbon/react'
import { Wallet, Connect, Login } from '@carbon/icons-react'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Account = { name: string; currency: string; balance: { amount: string; currency: string } }
type Status = { connected: boolean; configured: boolean; accounts?: Account[] }

export function CoinbaseConnect() {
  const { data, isLoading, mutate } = useSWR<Status>(
    '/api/coinbase/status',
    fetcher,
    { revalidateOnFocus: false },
  )

  async function disconnect() {
    await fetch('/api/coinbase/disconnect', { method: 'POST' })
    mutate()
  }

  const connected = data?.connected
  const configured = data?.configured

  return (
    <Tile className="coinbase-tile">
      <div className="coinbase__head">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Wallet size={20} />
          <span className="coinbase__title">Coinbase</span>
        </div>
        {connected ? (
          <Tag type="green" size="sm">
            Linked
          </Tag>
        ) : (
          <Tag type="cool-gray" size="sm">
            Not linked
          </Tag>
        )}
      </div>

      {isLoading ? (
        <SkeletonText paragraph lineCount={2} />
      ) : connected ? (
        <>
          <p className="coinbase__note">Funded balances from your linked account.</p>
          <div className="coinbase__accounts">
            {data?.accounts && data.accounts.length > 0 ? (
              data.accounts.map((a) => (
                <div className="coinbase__account" key={`${a.name}-${a.currency}`}>
                  <span>{a.name}</span>
                  <span>
                    {a.balance.amount} {a.balance.currency}
                  </span>
                </div>
              ))
            ) : (
              <p className="coinbase__note">No funded balances found.</p>
            )}
          </div>
          <Button kind="danger--tertiary" size="sm" onClick={disconnect}>
            Disconnect
          </Button>
        </>
      ) : (
        <>
          <p className="coinbase__note">
            Link your Coinbase account to view live balances alongside the desk&apos;s
            market signals. Read-only access.
          </p>
          {!configured && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Setup required"
              subtitle="Add COINBASE_CLIENT_ID and COINBASE_CLIENT_SECRET in Project Settings → Vars to enable linking."
              style={{ marginTop: '1rem', maxWidth: '100%' }}
            />
          )}
          <div style={{ marginTop: '1rem' }}>
            <Button
              href={configured ? '/api/coinbase/connect' : undefined}
              renderIcon={configured ? Login : Connect}
              disabled={!configured}
            >
              {configured ? 'Link Coinbase account' : 'Link (setup required)'}
            </Button>
          </div>
        </>
      )}
    </Tile>
  )
}
