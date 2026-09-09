/**
 * Find code nodes that print a whole object into the log stream (#1230).
 *
 * Why this is not a style rule. Cloudflare captures every console message into
 * `workers_trace_events` BEFORE any Bidspoke code runs, so `redactPii` and
 * `PII_REDACTION_FIELDS` cannot reach it, and that dataset is exportable by any
 * account-scoped Logpush job on an account shared with other Pennie projects. On
 * 2026-09-09 one such job was found exporting the `Logs` field to an external
 * vendor, which meant a code node printing the applicant had been sending SSNs
 * out of Pennie for months (#1007, #1214). A print is an egress, not local
 * output.
 *
 * What it flags: `JSON.stringify(x)` inside a console call, where `x` is a whole
 * value (an identifier, or a member expression). What it deliberately does not
 * flag: an object literal naming its own fields, which is a deliberate choice of
 * what to show, and anything wrapped in a redaction helper.
 *
 * The not-flagged cases carry as many tests as the flagged ones, because a shape
 * rule has to be proved against the content it must PRESERVE (L104): this runs
 * over every live definition daily, and an over-match would put a permanent
 * false finding in front of whoever reads the alert, which teaches them to skip
 * it.
 */

export interface PayloadPrint {
  /** The node's namespace, which is what an author recognises. */
  namespace: string
  nodeId: string
  /** The value being stringified, e.g. `parsedBody`. */
  identifier: string
  /** The line as written, trimmed, for the alert to quote. */
  line: string
}

/** Helpers whose whole purpose is to strip fields before logging. */
const REDACTION_HELPERS = /^(redact|mask|scrub|sanitizeForLog|safeForLog)/i

const CONSOLE_CALL = /console\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/

/**
 * `JSON.stringify(` followed by something that is NOT an object literal.
 * Captures the argument's leading token so the caller can name it and so a
 * redaction wrapper can be recognised.
 */
const STRINGIFY_ARG = /JSON\s*\.\s*stringify\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*[,)]/g

/**
 * Live definitions keep `type` and `namespace` flat on the node and the code at
 * `config.script`. The React Flow shape (`data.*`) is accepted too, because the
 * canvas uses it in memory and a caller may hand either one over.
 */
interface NodeLike {
  id?: unknown
  namespace?: unknown
  type?: unknown
  config?: { script?: unknown; code?: unknown }
  data?: { namespace?: unknown; type?: unknown; config?: { script?: unknown; code?: unknown } }
}

export function findPayloadPrints(definition: unknown): PayloadPrint[] {
  const nodes = (definition as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(nodes)) return []

  const out: PayloadPrint[] = []
  for (const raw of nodes as NodeLike[]) {
    const type = raw.type ?? raw.data?.type
    if (type !== 'code') continue
    const cfg = raw.config ?? raw.data?.config
    const code = cfg?.script ?? cfg?.code
    if (typeof code !== 'string') continue

    const nodeId = typeof raw.id === 'string' ? raw.id : ''
    const ns = raw.namespace ?? raw.data?.namespace
    const namespace = typeof ns === 'string' ? ns : nodeId

    for (const rawLine of code.split('\n')) {
      const line = rawLine.trim()
      // A commented line is not running. Checked before anything else so a
      // disabled debug print is not reported forever.
      if (line.startsWith('//') || line.startsWith('*')) continue
      if (!CONSOLE_CALL.test(line)) continue

      STRINGIFY_ARG.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = STRINGIFY_ARG.exec(line)) !== null) {
        const identifier = m[1]
        // A redaction wrapper is the fix, not the defect. Matched on the call
        // name that follows stringify, e.g. `JSON.stringify(redactForLog(x))`.
        if (REDACTION_HELPERS.test(identifier)) continue
        out.push({ namespace, nodeId, identifier, line })
      }
    }
  }
  return out
}
