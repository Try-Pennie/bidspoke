'use client'

/**
 * The Buyers considered table (#1412): for a buyer_select step, every buyer the
 * node looked at in priority order, what happened to each, and why, in the
 * shared vocabulary's words. The header says what the node did as a whole and
 * which mode it ran in, so a rehearsal is never read as a sale (L11). A buyer
 * that was not reached says so rather than sitting blank (L10), and an output
 * the page cannot read is shown as unreadable, never as an empty table (L633).
 */
import { AlertTriangle, CheckCircle, MinusCircle } from 'lucide-react'
import {
  CONSIDERED_OUTCOMES, CONSIDERED_OUTCOME_LABELS, MODE_EFFECTIVE, MODE_EFFECTIVE_LABELS, NODE_REASON_LABELS, OUT_REASON_LABELS,
  type ConsideredOutcome, type ModeEffective, type NodeReason, type OutReason,
} from '@bidspoke/buyer-profile'
import { ToneBadge, type Tone } from './ToneBadge'

export interface BuyerSelectStep {
  id: string
  step_namespace: string
  step_type: string
  step_node_id?: string | null
  parallel_group_id?: string | null
  status: string
  input: unknown
  output: unknown
  logs: Array<{ level: string; message: string; ts: string }> | null
  error_message: string | null
  error_type: string | null
  retries_used: number
  started_at: string
  completed_at: string
  duration_ms: number
  step_order: number
}

type Route = 'sold' | 'no_sale' | 'not_applicable' | 'deferred'
const ROUTES: readonly Route[] = ['sold', 'no_sale', 'not_applicable', 'deferred']

interface Considered {
  partner: string
  priority: number | null
  payout_cents: number | null
  outcome: ConsideredOutcome
  reason?: string
  detail?: string
}

interface Output {
  _route: Route
  reason: string
  detail?: string
  mode_effective: ModeEffective
  sale: { partner_slug: string | null; accepted: boolean }
  considered: Considered[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Reads the node output, or null when it is not the shape the node writes. */
export function readBuyerSelectOutput(output: unknown): Output | null {
  if (!isRecord(output)) return null
  const route = output._route
  const mode = output.mode_effective
  if (typeof route !== 'string' || !(ROUTES as readonly string[]).includes(route)) return null
  if (typeof mode !== 'string' || !(MODE_EFFECTIVE as readonly string[]).includes(mode)) return null
  if (typeof output.reason !== 'string' || !Array.isArray(output.considered) || !isRecord(output.sale)) return null
  const considered: Considered[] = []
  for (const c of output.considered) {
    if (!isRecord(c) || typeof c.partner !== 'string' || typeof c.outcome !== 'string') return null
    if (!(CONSIDERED_OUTCOMES as readonly string[]).includes(c.outcome)) return null
    considered.push({
      partner: c.partner,
      priority: typeof c.priority === 'number' ? c.priority : null,
      payout_cents: typeof c.payout_cents === 'number' ? c.payout_cents : null,
      outcome: c.outcome as ConsideredOutcome,
      reason: typeof c.reason === 'string' ? c.reason : undefined,
      detail: typeof c.detail === 'string' ? c.detail : undefined,
    })
  }
  return {
    _route: route as Route,
    reason: output.reason,
    detail: typeof output.detail === 'string' ? output.detail : undefined,
    mode_effective: mode as ModeEffective,
    sale: { partner_slug: typeof output.sale.partner_slug === 'string' ? output.sale.partner_slug : null, accepted: output.sale.accepted === true },
    considered,
  }
}

/** The plain words for a reason code from either shared list; the code itself when it is from neither. */
export function reasonLabel(reason: string | undefined): string {
  if (!reason) return ''
  if (reason in OUT_REASON_LABELS) return OUT_REASON_LABELS[reason as OutReason]
  if (reason in NODE_REASON_LABELS) return NODE_REASON_LABELS[reason as NodeReason]
  return reason
}

const OUTCOME_TONE: Record<ConsideredOutcome, Tone> = {
  sold: 'green',
  rehearsed: 'green',
  declined_by_buyer: 'red',
  buyer_error: 'red',
  outcome_unknown: 'amber',
  skipped: 'amber',
  ineligible: 'gray',
  eligible: 'gray',
  not_reached: 'gray',
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

function headline(out: Output): { text: string; tone: Tone } {
  const soldTo = out.considered.find((c) => c.outcome === 'sold')
  switch (out._route) {
    case 'sold': {
      const who = out.sale.partner_slug ?? soldTo?.partner ?? 'a buyer'
      const amount = soldTo?.payout_cents
      return { text: `Sold to ${who}${amount !== null && amount !== undefined ? ` for ${money(amount)}` : ''}`, tone: 'green' }
    }
    case 'no_sale':
      return { text: `No sale: ${reasonLabel(out.reason)}`, tone: 'red' }
    case 'not_applicable':
      return { text: `Not for sale: ${reasonLabel(out.reason)}`, tone: 'gray' }
    case 'deferred':
      // When the reason IS the mode (decide_only, report_only), the mode label beside the
      // namespace already says it, so the headline does not say it twice (L605).
      return { text: out.reason === out.mode_effective ? 'Left to the workflow to decide' : `Left to the workflow to decide: ${reasonLabel(out.reason)}`, tone: 'amber' }
  }
}

export function BuyersConsidered({ step }: { step: BuyerSelectStep }) {
  const out = readBuyerSelectOutput(step.output)
  if (!out) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50/30 p-4">
        <h3 className="font-mono text-sm font-semibold text-graphite">{step.step_namespace}</h3>
        <p role="alert" className="mt-1 text-xs text-red-700">The buyer selection output could not be read, so nothing here says what happened to the buyers.</p>
      </div>
    )
  }
  const head = headline(out)
  const frame = { green: 'border-green-200 bg-green-50/30', red: 'border-red-200 bg-red-50/30', amber: 'border-amber-200 bg-amber-50/30', gray: 'border-gray-200 bg-gray-50/40' }[head.tone]
  const icon = head.tone === 'green' ? <CheckCircle className="h-4 w-4 text-green-600" aria-hidden="true" />
    : head.tone === 'gray' ? <MinusCircle className="h-4 w-4 text-gray-500" aria-hidden="true" />
    : <AlertTriangle className={`h-4 w-4 ${head.tone === 'red' ? 'text-red-600' : 'text-amber-600'}`} aria-hidden="true" />
  const rows = [...out.considered].sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))

  return (
    <div className={`rounded-xl border ${frame} p-4`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="font-mono text-sm font-semibold text-graphite">{step.step_namespace}</h3>
          <span className="text-xs text-gray-600">{MODE_EFFECTIVE_LABELS[out.mode_effective]}</span>
        </div>
        <p className={`text-xs font-medium ${{ green: 'text-green-700', red: 'text-red-700', amber: 'text-amber-800', gray: 'text-gray-700' }[head.tone]}`}>
          {head.text}{out.detail ? <span className="font-normal text-gray-600"> ({out.detail})</span> : null}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600">No buyer was considered.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th scope="col" className="px-3 py-2 text-right font-medium">Priority</th>
                <th scope="col" className="px-3 py-2 font-medium">Buyer</th>
                <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Payout</th>
                <th scope="col" className="px-3 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((c, i) => {
                const took = c.outcome === 'sold'
                const why = [reasonLabel(c.reason), c.detail].filter(Boolean).join('. ')
                return (
                  <tr key={`${c.partner}-${i}`} aria-current={took ? 'true' : undefined} className={took ? 'bg-green-50/40' : ''}>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-600">{c.priority ?? 'none'}</td>
                    <td className="px-3 py-2 font-mono text-graphite">{c.partner}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><ToneBadge tone={OUTCOME_TONE[c.outcome]}>{CONSIDERED_OUTCOME_LABELS[c.outcome]}</ToneBadge></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-graphite">{c.payout_cents === null ? 'none' : money(c.payout_cents)}</td>
                    <td className="px-3 py-2 text-gray-600">{why}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
