import {
  ToolLoopAgent,
  tool,
  readUIMessageStream,
  toUIMessageStream,
  InferAgentUIMessage,
} from 'ai'
import { z } from 'zod'
import {
  getSegmentQuotes,
  formatQuotesForModel,
  SEGMENTS,
  type Segment,
} from '@/lib/markets'

const ORCHESTRATOR_MODEL = 'anthropic/claude-sonnet-4.6'
const SUBAGENT_MODEL = 'anthropic/claude-haiku-4.5'

/**
 * Each market segment is handled by a dedicated subagent. A subagent has a single
 * tool that pulls live quotes for its segment, then writes a focused summary that
 * is returned to the orchestrator.
 */
function createSegmentSubagent(segment: Segment) {
  const { label } = SEGMENTS[segment]
  return new ToolLoopAgent({
    model: SUBAGENT_MODEL,
    instructions: `You are the ${label} analyst, a specialized market subagent.
Call the getLiveQuotes tool exactly once to retrieve current prices for your segment.
Then analyze momentum, notable movers, and risk.

IMPORTANT: Your final response must be a concise summary (3-5 sentences) covering:
- The overall tone of this segment right now (risk-on / risk-off / mixed)
- The single most notable mover and why it matters
- A short, clearly-labeled signal: BULLISH, BEARISH, or NEUTRAL
This summary is returned to the orchestrator, so make it self-contained.`,
    tools: {
      getLiveQuotes: tool({
        description: `Fetch current live quotes for the ${label} segment.`,
        inputSchema: z.object({}),
        execute: async () => {
          const quotes = await getSegmentQuotes(segment)
          return formatQuotesForModel(segment, quotes)
        },
      }),
    },
  })
}

const subagents = {
  global: createSegmentSubagent('global'),
  metals: createSegmentSubagent('metals'),
  us: createSegmentSubagent('us'),
  crypto: createSegmentSubagent('crypto'),
}

function createDelegationTool(segment: Segment) {
  const { label } = SEGMENTS[segment]
  return tool({
    description: `Delegate analysis of the ${label} segment to its specialist subagent. The subagent pulls live data and returns an analysis with a BULLISH/BEARISH/NEUTRAL signal.`,
    inputSchema: z.object({
      focus: z
        .string()
        .describe('What the orchestrator wants this subagent to focus on.'),
    }),
    execute: async function* ({ focus }, { abortSignal }) {
      const result = await subagents[segment].stream({
        prompt: `Analyze the ${label} segment. Orchestrator focus: ${focus}`,
        abortSignal,
      })
      for await (const message of readUIMessageStream({
        stream: toUIMessageStream({ stream: result.stream }),
      })) {
        yield message
      }
    },
    toModelOutput: ({ output: message }) => {
      const lastText = message?.parts?.findLast?.(
        (p: { type: string }) => p.type === 'text',
      ) as { text?: string } | undefined
      return {
        type: 'text',
        value: lastText?.text ?? 'Subagent completed with no summary.',
      }
    },
  })
}

export const orchestrator = new ToolLoopAgent({
  model: ORCHESTRATOR_MODEL,
  instructions: `You are the Orchestrator, the lead agent of an agentic trading desk.
You coordinate four specialist subagents, each covering one market segment:
- analyzeGlobal: international equity indices
- analyzeMetals: gold, silver, platinum
- analyzeUS: US equity indices
- analyzeCrypto: leading digital assets

Workflow for every request:
1. Delegate to ALL FOUR subagents (each call fetches its own live data).
2. Wait for their signals, then synthesize a single cross-market briefing.

Your final response must be well-structured markdown with these sections:
### Cross-Market Read
One paragraph on how the segments relate right now.

### Segment Signals
A bullet per segment with its signal (BULLISH / BEARISH / NEUTRAL) and one line of reasoning.

### Suggested Positioning
2-3 concrete, clearly-hedged ideas. Always include this exact disclaimer as the final line:
_Informational only — not financial advice._

Be decisive but never omit the disclaimer.`,
  tools: {
    analyzeGlobal: createDelegationTool('global'),
    analyzeMetals: createDelegationTool('metals'),
    analyzeUS: createDelegationTool('us'),
    analyzeCrypto: createDelegationTool('crypto'),
  },
})

export type OrchestratorUIMessage = InferAgentUIMessage<typeof orchestrator>
