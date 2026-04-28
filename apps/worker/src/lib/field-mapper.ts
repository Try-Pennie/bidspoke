/**
 * Outbound field mapping — applied to the trigger payload right before a
 * partner API call. Eliminates the need for a Transform/Code node in every
 * workflow that talks to a particular partner.
 *
 * Shape (same as Transform node):
 *   { mappings: [{ source: 'debt_amount', target: 'DebtAmount' }, ...] }
 *
 * source is a dot-path into the payload (e.g. 'lead.debt_amount').
 * target is the wire-format field name (e.g. 'DebtAmount__c').
 *
 * Identity behavior: if mapping is null, undefined, or has no rows, the
 * payload is returned unchanged. Missing source paths produce null at the
 * target — same as the Transform node.
 */

interface MappingRule {
  source: string
  target: string
}

interface OutboundMapping {
  mappings?: MappingRule[]
}

export function applyOutboundMapping(
  payload: unknown,
  mapping: Record<string, unknown> | null | undefined
): unknown {
  if (!mapping || typeof mapping !== 'object') return payload
  const rules = (mapping as OutboundMapping).mappings
  if (!Array.isArray(rules) || rules.length === 0) return payload

  const out: Record<string, unknown> = {}
  for (const rule of rules) {
    if (!rule || typeof rule.target !== 'string' || !rule.target) continue
    const value = readPath(payload, rule.source)
    setPath(out, rule.target, value)
  }
  return out
}

function readPath(obj: unknown, path: string): unknown {
  if (typeof path !== 'string' || !path) return null
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur ?? null
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    const next = cur[part]
    if (typeof next !== 'object' || next === null) {
      cur[part] = {}
    }
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}
