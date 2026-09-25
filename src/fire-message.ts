import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Build the user-role message used for one cron fire delivery.
 *
 * The producer-owned `cron` source is kept in this factory so the attribution
 * survives persistence and downstream consumers can classify cron-driven turns.
 */
export function cronFireMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'cron' },
  })
}
