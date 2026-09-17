import type { StepLogEntry } from '../types'

/**
 * Shared parsing of a code-sandbox worker response.
 *
 * Both dispatch paths get the same response shape back from the same worker:
 * the single-node path (`nodes/code.ts`) and the per-node fallback inside
 * `executeCodeChain`. They used to parse it separately, and the fallback copy
 * never checked the HTTP status, so a script error (500 carrying the
 * `{__bsv:1, error, name}` envelope) was JSON-parsed and recorded as a
 * `completed` step whose output WAS the error envelope (#460). One parser now
 * serves both, so an error can only ever be read as an error.
 */

export interface CodeSandboxEnvelope {
  __bsv: 1
  output?: unknown
  logs?: unknown
  error?: string
  name?: string
  /** Non-2xx responses the script fetched, recorded by the sandbox for the engine's block
   *  page detector (#1265). Absent from a bundle built before the capture existed. */
  blocks?: unknown
}

/** One non-2xx response a code node's script fetched, as the sandbox records it. */
export interface SandboxBlockRecord {
  host: string
  url: string
  status: number
  contentType: string | null
  cfRay: string | null
  cfMitigated: string | null
  bodyHead: string
}

export function readBlockRecords(raw: unknown): SandboxBlockRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((r): r is SandboxBlockRecord =>
    !!r && typeof r === 'object' && typeof (r as SandboxBlockRecord).url === 'string' && typeof (r as SandboxBlockRecord).status === 'number',
  )
}

export function isCodeEnvelope(v: unknown): v is CodeSandboxEnvelope {
  return v !== null && typeof v === 'object' && (v as { __bsv?: unknown }).__bsv === 1
}

export type ParsedCodeResponse =
  | { ok: true; output: unknown; logs?: StepLogEntry[]; blocks?: SandboxBlockRecord[] }
  /** `errorName` is the thrown error's constructor name, present only on
   *  envelope-aware bundles. The classifier uses it to fail a deterministic
   *  programming error fast rather than retrying it (#458). */
  | { ok: false; error: string; errorName?: string; logs?: StepLogEntry[]; blocks?: SandboxBlockRecord[] }

/**
 * Parse a code-sandbox response body into either its output or its error.
 * `ok` is the response's own `res.ok`, the only thing that decides which side
 * of the union you get, so a non-2xx can never be read as output.
 */
export function parseCodeSandboxResponse(ok: boolean, text: string): ParsedCodeResponse {
  // Bundles deployed before envelope support return bare output; the `__bsv`
  // flag tells them apart with no collision risk against a user-returned
  // object that happens to be shaped like {output, logs}.
  let parsed: unknown = null
  if (text !== '' && text !== 'undefined') {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  const envelope = isCodeEnvelope(parsed) ? parsed : null
  const logs = envelope && Array.isArray(envelope.logs) ? (envelope.logs as StepLogEntry[]) : undefined
  const blocks = envelope ? readBlockRecords(envelope.blocks) : undefined

  if (!ok) {
    const error = envelope ? (envelope.error ?? text) : extractLegacyError(text)
    const errorName = envelope && typeof envelope.name === 'string' ? envelope.name : undefined
    return { ok: false, error, errorName, logs, blocks }
  }

  return { ok: true, output: envelope ? (envelope.output ?? null) : parsed, logs, blocks }
}

/** A pre-envelope bundle reports a script error as a bare `{error}` body. */
function extractLegacyError(text: string): string {
  try {
    const p = JSON.parse(text) as { error?: string }
    if (p?.error) return p.error
  } catch { /* keep raw text */ }
  return text
}
