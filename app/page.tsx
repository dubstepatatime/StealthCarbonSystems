import { Grid, Column, Tag } from '@carbon/react'
import { MarketOverview } from '@/components/dashboard/market-overview'
import { AgentConsole } from '@/components/dashboard/agent-console'
import { CoinbaseConnect } from '@/components/dashboard/coinbase-connect'

export default function Page() {
  return (
    <main id="main-content" className="page-main">
      <div className="hero">
        <Grid>
          <Column sm={4} md={8} lg={12}>
            <div className="desk-hero__eyebrow">Agentic Trading Desk</div>
            <h1 className="hero__title">Multi-agent market intelligence</h1>
            <p className="hero__subtitle">
              One orchestrator agent coordinates four specialist subagents across US
              equities, crypto, precious metals, and global markets — each pulling live
              data — then synthesizes a single cross-market briefing.
            </p>
            <div className="desk-hero__meta">
              <span className="desk-hero__meta-item">
                <Tag type="green" size="sm">
                  Live data
                </Tag>
                Quotes refresh every 30s
              </span>
            </div>
          </Column>
        </Grid>
      </div>

      <section className="section">
        <Grid>
          <Column sm={4} md={8} lg={10}>
            <AgentConsole />
          </Column>
          <Column sm={4} md={8} lg={6}>
            <CoinbaseConnect />
          </Column>
        </Grid>
      </section>

      <section className="section">
        <Grid>
          <Column sm={4} md={8} lg={16}>
            <h2 className="section__title">Live Markets</h2>
            <p className="section__subtitle">
              The same feeds each subagent analyzes, updated in real time.
            </p>
          </Column>
        </Grid>
        <MarketOverview />
      </section>
    </main>
  )
}
