'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Tile, Button, Tag, InlineLoading, InlineNotification } from '@carbon/react'
import { Play, Renew, Bot } from '@carbon/icons-react'
import type { OrchestratorUIMessage } from '@/lib/agents'

const SUBAGENT_LABELS: Record<string, string> = {
  'tool-analyzeGlobal': 'Global Markets Subagent',
  'tool-analyzeMetals': 'Gold & Silver Subagent',
  'tool-analyzeUS': 'US Market Subagent',
  'tool-analyzeCrypto': 'Crypto Market Subagent',
}

function lastText(parts: Array<{ type: string; text?: string }> | undefined) {
  const t = parts?.findLast?.((p) => p.type === 'text')
  return t?.text ?? ''
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((raw, i) => {
        const line = raw.trimEnd()
        if (!line.trim()) return null
        if (line.startsWith('### ')) {
          return (
            <h3 key={i} style={{ marginTop: '1rem', marginBottom: '0.25rem' }}>
              {line.slice(4)}
            </h3>
          )
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} style={{ paddingLeft: '1rem' }}>
              {'• '}
              {inline(line.slice(2))}
            </div>
          )
        }
        if (line.startsWith('_') && line.endsWith('_')) {
          return (
            <em key={i} style={{ color: 'var(--cds-text-secondary)' }}>
              {line.slice(1, -1)}
            </em>
          )
        }
        return <p key={i}>{inline(line)}</p>
      })}
    </>
  )
}

function inline(text: string) {
  const segments = text.split(/(\*\*[^*]+\*\*)/g)
  return segments.map((seg, i) =>
    seg.startsWith('**') && seg.endsWith('**') ? (
      <strong key={i}>{seg.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{seg}</span>
    ),
  )
}

export function AgentConsole() {
  const { messages, sendMessage, status, setMessages, error } =
    useChat<OrchestratorUIMessage>({
      transport: new DefaultChatTransport({ api: '/api/analyze' }),
    })

  const running = status === 'submitted' || status === 'streaming'
  const hasRun = messages.length > 0

  function run() {
    if (running) return
    if (hasRun) setMessages([])
    sendMessage({
      text: 'Run a full cross-market analysis using all four subagents and give me positioning.',
    })
  }

  return (
    <Tile className="console-tile">
      <div className="console__toolbar">
        <div>
          <div className="console__title">Orchestrator Agent</div>
          <div className="console__subtitle">
            Delegates to four market subagents pulling live data, then synthesizes a
            briefing.
          </div>
        </div>
        <Button
          onClick={run}
          disabled={running}
          renderIcon={hasRun ? Renew : Play}
          kind="primary"
          size="md"
        >
          {running ? 'Analyzing…' : hasRun ? 'Re-run analysis' : 'Run analysis'}
        </Button>
      </div>

      <div className="console__stream">
        {!hasRun && !running && (
          <div className="console__empty">
            Idle. Run the orchestrator to fan out live-data subagents across US,
            crypto, metals, and global markets.
          </div>
        )}

        {messages.map((message) =>
          message.role === 'assistant'
            ? message.parts.map((part, i) => {
                if (part.type === 'text') {
                  if (!part.text.trim()) return null
                  return (
                    <div key={i} className="orchestrator-answer">
                      <MarkdownLite text={part.text} />
                    </div>
                  )
                }

                if (part.type in SUBAGENT_LABELS) {
                  const anyPart = part as unknown as {
                    state: string
                    preliminary?: boolean
                    output?: { parts?: Array<{ type: string; text?: string }> }
                  }
                  const streaming =
                    anyPart.state === 'output-available' && anyPart.preliminary
                  const done =
                    anyPart.state === 'output-available' && !anyPart.preliminary
                  const summary = lastText(anyPart.output?.parts)

                  return (
                    <div key={i} className="subagent">
                      <div className="subagent__head">
                        <Bot size={16} />
                        <span className="subagent__name">
                          {SUBAGENT_LABELS[part.type]}
                        </span>
                        {done ? (
                          <Tag type="green" size="sm">
                            complete
                          </Tag>
                        ) : streaming ? (
                          <Tag type="blue" size="sm">
                            working
                          </Tag>
                        ) : (
                          <Tag type="cool-gray" size="sm">
                            dispatched
                          </Tag>
                        )}
                      </div>
                      {summary ? (
                        <div className="subagent__body">{summary}</div>
                      ) : (
                        <InlineLoading description="Pulling live data…" />
                      )}
                    </div>
                  )
                }

                return null
              })
            : null,
        )}

        {running && (
          <InlineLoading
            status="active"
            description="Orchestrator coordinating subagents…"
          />
        )}

        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Agent run failed"
            subtitle={error.message}
            style={{ maxWidth: '100%' }}
          />
        )}
      </div>
    </Tile>
  )
}
