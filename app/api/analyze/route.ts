import { createAgentUIStreamResponse } from 'ai'
import { orchestrator } from '@/lib/agents'

export const maxDuration = 60

export async function POST(request: Request) {
  const { messages } = await request.json()

  return createAgentUIStreamResponse({
    agent: orchestrator,
    uiMessages: messages ?? [],
    onError: (error) =>
      error instanceof Error ? error.message : String(error),
  })
}
