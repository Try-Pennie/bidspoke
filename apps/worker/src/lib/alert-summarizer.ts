// Drafts a one-sentence root-cause explanation for an execution Slack alert.
// Called fire-and-forget from the engine after the alert posts: result is
// written to workflow_executions.slack_alert_reason.summary and posted as a
// thread reply on the original Slack message.

import type { StepStatus, ErrorType } from '../types'
import { parseJson } from './json'
import { stripUrlQueriesInText } from './url-redact'

export interface AlertSummaryStep {
  step_namespace: string
  step_type: string
  duration_ms: number
  status: StepStatus
  error_message?: string | null
  error_type?: ErrorType | null
}

export interface AlertSummaryInput {
  alert_type: 'failure' | 'duration'
  workflow_name: string
  total_duration_ms: number
  threshold_ms?: number
  bottleneck: AlertSummaryStep
  top_steps: AlertSummaryStep[]
}

const SYSTEM_PROMPT = `You explain why a workflow automation run triggered an alert. Write one or two sentences in plain English for an engineer who didn't watch the run.

Inputs you'll receive:
- alert_type: "failure" (a step errored) or "duration" (run exceeded a time threshold).
- bottleneck: the failed step (for failure alerts) or the longest-running step (for duration alerts).
- top_steps: the five longest steps by wall-clock time, in descending order.

Rules:
- Lead with the cause. Name the step in backticks.
- For duration alerts, when the bottleneck is a 'code' / 'webhook' / 'salesforce' step, infer that the upstream service it called was slow. Code nodes that take >1s are almost always waiting on a fetch. Do not claim to know which service unless the step namespace makes it obvious (e.g. 'engine', 'tripoint', 'equifax', 'salesforce').
- For failure alerts, state the error class (transient/permanent) and the message verbatim if it's under 80 chars; otherwise paraphrase.
- No preamble, no "this run", no markdown headers, no rationale beyond what the data shows.
- Past tense.`

export async function draftAlertSummary(
  apiKey: string,
  input: AlertSummaryInput
): Promise<string | null> {
  if (!apiKey) return null

  // Sent to an outside service: an address in a step error loses its query string first (L741, #1740).
  const userMsg = stripUrlQueriesInText(JSON.stringify(input, null, 2))

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Anthropic ${res.status}: ${txt}`)
  }

  const data = await parseJson<{ content?: Array<{ type: string; text?: string }> }>(res)
  const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
  return text.trim() || null
}
