/**
 * What a partner-facing response must carry, checked at the boundary (#933).
 *
 * Nothing checked that a response contained the fields we promised. On
 * 2026-08-20 eight rejection paths across four live bidding workflows had been
 * omitting `lead_id` for months: two read a payload field the partner never
 * sends, six never set it at all. In every case the key VANISHED from the JSON
 * rather than arriving empty, because a template resolving to undefined returns
 * undefined and JSON serialization drops the key (`context.ts`, and the same
 * happens to an object literal in a code node). So no run failed, nothing
 * alerted, and partners received rejections they could not tie back to the lead
 * they sent. It was found because a human read one response by hand. Volume
 * before the fix was 46% of Lead Economy traffic over 7 days (L505).
 *
 * Two decisions worth stating, because both could have gone the other way.
 *
 * It REPORTS, it never blocks. A rejection missing one field is still a usable
 * rejection; refusing to send it turns that into a 500 and breaks the
 * integration outright, which is strictly worse for the partner. The issue
 * flagged this as open and this is the answer.
 *
 * The contract is per FAMILY, not a flat list of keys, because a flat list would
 * be false. Measured over 1,200 real responses (see
 * `__tests__/fixtures/response-shapes.json`), the bidding workflows send two
 * shapes: a rejection carrying `{lead_id, reason, status}` and an offer carrying
 * `{offers, requestId}`. The offer family has no `lead_id` and no `status`, so
 * "every response must contain lead_id" would fire on every successful bid. What
 * is actually invariant is that the partner can tie the response back to the lead
 * it sent, and each family satisfies that its own way.
 *
 * A body matching no declared family is reported as `unrecognised` rather than
 * passed. That is not pedantry: the measurement turned up 2 Lead Economy
 * responses shaped `{error, trace_id}`, and `trace_id` is OUR identifier, so a
 * partner receiving one cannot correlate it at all. An undeclared family is the
 * first place a new instance of this defect will appear.
 *
 * And a workflow with no declaration at all is reported as `undeclared`, never
 * silently passed. A hand-written registry only checks what it lists (L96), so
 * the gap has to be visible from the outside; the counted signal is what makes
 * it reviewable rather than an exemption with no reviewer (L129).
 */

/** One response shape a workflow is allowed to send. */
export interface ResponseFamily {
  /** Name used in the log signal, so a violation says which shape it judged. */
  name: string
  /**
   * The key whose presence identifies this family. Chosen from measurement: a
   * body carrying `reason` is a rejection, one carrying `offers` is an offer.
   */
  discriminator: string
  /** Keys that must be present AND non-empty on this family. */
  required: string[]
}

export interface ResponseContract {
  workflowId: string
  /** Carried so a log line names the workflow rather than only its uuid. */
  workflowName: string
  families: ResponseFamily[]
}

/**
 * The rejection and offer families, identical across the bidding workflows
 * because they answer the same partner protocol. Declared once and shared rather
 * than copied per workflow, so a correction lands everywhere at once.
 */
const REJECTION: ResponseFamily = {
  name: 'rejection',
  discriminator: 'reason',
  // lead_id is the field the incident was about. status and reason are required
  // because every one of the 1,025 measured rejections carried them, so a
  // rejection missing either is a real deviation and not a shape we simply have
  // not seen.
  required: ['lead_id', 'reason', 'status'],
}

const OFFER: ResponseFamily = {
  name: 'offer',
  discriminator: 'offers',
  // requestId is this family's correlation identifier: it carries no lead_id,
  // which is why the contract cannot be a flat key list.
  required: ['offers', 'requestId'],
}

const BIDDING_FAMILIES = [REJECTION, OFFER]

/**
 * Main Flow's families (#956), measured 2026-09-01 over its 300 most recent
 * non-test responses. It is the highest-volume partner-facing workflow we run,
 * and it was undeclared, so the check covered the workflows least likely to be
 * edited and missed the one most likely to be.
 *
 * Four families, and every one of the 300 measured responses falls into one of
 * them, with none unmatched. They are ordered because the FIRST family whose
 * discriminator is present wins, and an offer-wall response also carries
 * `routingPartner`: putting `routed` first would swallow it and judge it against
 * the wrong contract.
 *
 * What each requires is what the measurement showed is actually invariant for
 * that family, which is not the same set across families. The offer wall does
 * NOT require ADV and XBC, because 8 of its 145 responses carry neither, and a
 * contract that demanded them would fire on ordinary traffic (L48). It requires
 * the identifiers instead, which is the invariant that matters: the caller can
 * tie the response back to the lead it sent.
 */
const MAIN_FLOW_DEBT_KEYS = ['ADV', 'XBC', 'unsecuredDebtVerified']

const MAIN_FLOW_FAMILIES: ResponseFamily[] = [
  // 145 of 300. Carries routingPartner too, so it must be matched first.
  { name: 'offer_wall', discriminator: 'loanOffers', required: ['uuid', 'leadUuid'] },
  // 67 of 300, all three keys present and non-empty on every one.
  { name: 'routed', discriminator: 'routingPartner', required: MAIN_FLOW_DEBT_KEYS },
  // 86 of 300, likewise.
  { name: 'debt', discriminator: 'debtAmount', required: MAIN_FLOW_DEBT_KEYS },
  // Only 2 of 300, so this family is declared on a thin sample and is the one
  // most likely to need revisiting. It is declared rather than left out because
  // the alternative is that those responses report as `unrecognised` forever,
  // which would be a standing false alarm rather than an honest gap.
  { name: 'verified_only', discriminator: 'unsecuredDebtVerified', required: MAIN_FLOW_DEBT_KEYS },
]

/**
 * Declared per workflow. Seeded from the measured fixture, not from memory.
 *
 * Five workflows are still absent, and deliberately: `Bidding - LendSwift`,
 * `Main Flow (v2)`, `Offer Wall by Submission ID`,
 * `Forms <> Engine <> Data Store (Loan only)` and
 * `Delegate Gmail Access for Offboarded Agents` each had ZERO non-test
 * executions over the measurement window, so there is nothing to declare a
 * contract from. Guessing one would be inventing the same kind of fiction this
 * file exists to catch. They report as `undeclared` until they have traffic to
 * measure, which is the honest state and a visible one.
 */
export const RESPONSE_CONTRACTS: ResponseContract[] = [
  {
    workflowId: 'da82a183-1a4a-417e-b0b8-5f3fe5e14840',
    workflowName: 'Engine Bidding Workflow',
    families: BIDDING_FAMILIES,
  },
  {
    workflowId: '89b1a6af-7e0f-43de-bc66-1e888184551f',
    workflowName: 'Lead Economy - Bidding Workflow',
    families: BIDDING_FAMILIES,
  },
  {
    workflowId: '6624acd0-bf61-4d21-85fc-4371ca7ed77d',
    workflowName: 'RML - Bidding Workflow (GigFi)',
    families: BIDDING_FAMILIES,
  },
  {
    workflowId: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914',
    workflowName: 'RML - Bidding Workflow (LendSwift)',
    families: BIDDING_FAMILIES,
  },
  {
    workflowId: '60e2e0bc-5aa2-47db-b333-3a8fe1c62e09',
    workflowName: 'Main Flow',
    families: MAIN_FLOW_FAMILIES,
  },
]

export type ContractVerdict =
  | { status: 'ok'; family: string }
  | { status: 'missing'; family: string; missing: string[]; workflowName: string }
  | { status: 'unrecognised'; keys: string[]; workflowName: string }
  | { status: 'undeclared' }
  | { status: 'not-a-body' }

/**
 * A value that would be DROPPED or read as absent by the partner. `undefined` is
 * the case the incident was made of: the key is in the object and gone from the
 * JSON. An empty string and null are included because a partner cannot correlate
 * on them either, and a field that arrives empty is the same failure wearing a
 * different hat.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * Check one assembled response body against its workflow's contract.
 *
 * Pure, and deliberately total: every outcome is a named verdict rather than a
 * boolean, so a caller cannot collapse "no contract declared" into "fine"
 * (L11). Never throws, because losing the response is worse than any reporting
 * gap this could have.
 */
export function checkResponseContract(
  workflowId: string,
  body: unknown,
  contracts: ResponseContract[] = RESPONSE_CONTRACTS,
): ContractVerdict {
  const contract = contracts.find((c) => c.workflowId === workflowId)
  if (!contract) return { status: 'undeclared' }

  // A non-object body (a bare string, a number, null) carries no keys to judge.
  // Reported as its own verdict rather than as a violation, because a workflow
  // that legitimately answers with a bare value has no fields to be missing.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'not-a-body' }
  const obj = body as Record<string, unknown>

  const family = contract.families.find((f) => Object.prototype.hasOwnProperty.call(obj, f.discriminator))
  if (!family) {
    return { status: 'unrecognised', keys: Object.keys(obj).sort(), workflowName: contract.workflowName }
  }

  const missing = family.required.filter((f) => !Object.prototype.hasOwnProperty.call(obj, f) || isAbsent(obj[f]))
  if (missing.length > 0) {
    return { status: 'missing', family: family.name, missing, workflowName: contract.workflowName }
  }
  return { status: 'ok', family: family.name }
}

/** Distinct log event names, so each outcome is countable on its own (L53). */
export const RESPONSE_CONTRACT_EVENTS = {
  missing: 'response_contract_missing_field',
  unrecognised: 'response_contract_unrecognised_shape',
  undeclared: 'response_contract_undeclared_workflow',
} as const

/**
 * Workflows already reported as undeclared in this isolate.
 *
 * `undeclared` is a CONFIGURATION gap, not a per-run event: it is equally true
 * of every execution of that workflow, so a line per run would be hundreds of
 * thousands a day and would bury the two signals that describe actual defects.
 * Deduplicating it per isolate keeps it discoverable (a recycled isolate says it
 * again) while costing one line rather than one per lead.
 *
 * The other two are deliberately NOT deduplicated. A missing field and an
 * unrecognised shape are per-response defects whose VOLUME is the signal, and
 * collapsing them would make one bad path indistinguishable from a systemic one,
 * which is the failure L77 describes.
 */
const undeclaredReported = new Set<string>()

/** Test seam: the dedup set is module state, so a suite must be able to clear it. */
export function resetUndeclaredReporting(): void {
  undeclaredReported.clear()
}

/**
 * Emit the verdict. Structured and one event name per outcome, so the three can
 * be counted and alerted separately instead of sharing one status field.
 *
 * `ok` and `not-a-body` are silent: a line per healthy response would be 800k
 * lines a day and would bury the three that matter.
 */
export function reportResponseContract(
  verdict: ContractVerdict,
  ctx: { workflowId: string; executionId: string; traceId: string },
): void {
  if (verdict.status === 'ok' || verdict.status === 'not-a-body') return

  const base = { workflow_id: ctx.workflowId, execution_id: ctx.executionId, trace_id: ctx.traceId }
  if (verdict.status === 'missing') {
    console.error(
      JSON.stringify({
        event: RESPONSE_CONTRACT_EVENTS.missing,
        ...base,
        workflow_name: verdict.workflowName,
        family: verdict.family,
        missing_fields: verdict.missing,
        detail: `the partner received a ${verdict.family} response without ${verdict.missing.join(', ')}, so it cannot tie the response to the lead it sent`,
      }),
    )
    return
  }
  if (verdict.status === 'unrecognised') {
    console.error(
      JSON.stringify({
        event: RESPONSE_CONTRACT_EVENTS.unrecognised,
        ...base,
        workflow_name: verdict.workflowName,
        keys: verdict.keys,
        detail: 'this response matches no declared family, so nothing checked whether it carries what the partner needs',
      }),
    )
    return
  }
  if (undeclaredReported.has(ctx.workflowId)) return
  undeclaredReported.add(ctx.workflowId)
  console.warn(
    JSON.stringify({
      event: RESPONSE_CONTRACT_EVENTS.undeclared,
      ...base,
      detail:
        'this workflow has no declared response contract, so its responses are unchecked. ' +
        'Reported once per isolate, because it is equally true of every execution.',
    }),
  )
}
