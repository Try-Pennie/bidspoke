'use client'

export const runtime = 'edge'

import { useMemo, useState } from 'react'
import NavLayout from '@/components/NavLayout'
import { Copy, Check, ArrowRight } from 'lucide-react'

type ConvertResult =
  | { ok: true; payload: unknown; note: string }
  | { ok: false; error: string }

/**
 * Extracts the Bidspoke trigger payload from whatever shape of Pipedream JSON
 * the user pasted. Handles three common inputs:
 *   1. Full steps.trigger with {context, event: {body}} — use event.body
 *   2. Just the event object with {body}                 — use body
 *   3. Anything else                                     — pass through as-is
 */
function convert(input: string): ConvertResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: '' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JSON object at the top level.' }
  }

  const obj = parsed as Record<string, unknown>

  // Case 1: full steps.trigger (has context + event)
  if (obj.event && typeof obj.event === 'object' && !Array.isArray(obj.event)) {
    const event = obj.event as Record<string, unknown>
    if ('body' in event) {
      return { ok: true, payload: event.body, note: 'Extracted event.body from full steps.trigger object.' }
    }
    return { ok: true, payload: event, note: 'Used the event object directly (no body field found).' }
  }

  // Case 2: the event object itself (has body but not context)
  if ('body' in obj && obj.body && typeof obj.body === 'object') {
    return { ok: true, payload: obj.body, note: 'Extracted body from event-like object.' }
  }

  // Case 3: already looks like a payload — pass through
  return { ok: true, payload: obj, note: 'No Pipedream wrapper found — passed through as-is.' }
}

export default function TriggerConverterPage() {
  const [input, setInput] = useState('')
  const [copied, setCopied] = useState(false)

  const result = useMemo(() => convert(input), [input])

  const output =
    result.ok && input.trim() !== ''
      ? JSON.stringify(result.payload, null, 2)
      : ''

  const onCopy = () => {
    if (!output) return
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <NavLayout>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-graphite">Pipedream → Bidspoke</h1>
          <p className="mt-1 text-sm text-gray-500">
            Paste a Pipedream <code className="rounded bg-beige px-1 py-0.5 font-mono text-xs">steps.trigger</code> JSON on the left.
            The right shows just the payload Bidspoke expects for its trigger.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
          {/* Input */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Pipedream input</p>
              {input && !result.ok && (
                <p className="text-xs text-red-600">Invalid JSON</p>
              )}
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              placeholder='{\n  "context": { ... },\n  "event": {\n    "body": { ... }\n  }\n}'
              className="h-[60vh] w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-xs leading-relaxed text-gray-800 focus:border-p-blue focus:outline-none focus:ring-2 focus:ring-p-blue/20"
            />
            {result.ok && input.trim() !== '' && (
              <p className="mt-1.5 text-xs text-gray-400">{result.note}</p>
            )}
            {!result.ok && input.trim() !== '' && (
              <p className="mt-1.5 text-xs text-red-600">{result.error}</p>
            )}
          </section>

          {/* Arrow — desktop only */}
          <div className="hidden items-center justify-center pt-8 md:flex">
            <ArrowRight className="h-5 w-5 text-gray-300" />
          </div>

          {/* Output */}
          <section>
            <div className="mb-1.5 flex items-baseline justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Bidspoke payload</p>
              <button
                type="button"
                onClick={onCopy}
                disabled={!output}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-beige disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-green-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <textarea
              value={output}
              readOnly
              spellCheck={false}
              placeholder="Paste a Pipedream trigger on the left to see the Bidspoke payload here."
              className="h-[60vh] w-full rounded-lg border border-gray-200 bg-beige/40 px-3 py-2.5 font-mono text-xs leading-relaxed text-gray-800 focus:outline-none"
            />
          </section>
        </div>
      </div>
    </NavLayout>
  )
}
