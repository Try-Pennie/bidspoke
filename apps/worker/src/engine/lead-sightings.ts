// Lead sightings + bids + persons writes.
// All writes are best-effort and run in waitUntil; failures must not block the engine.
// Snowflake mirror: rows are pushed nightly and deleted from Supabase after export.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition, StepOutput } from '../types'
import { encryptPii, formatSsn, hashSsn } from './persons-crypto'

// ============================================================
// Types
// ============================================================

export interface SightingInsert {
  id: string
  trace_id: string
  execution_id: string
  workflow_id: string
  workflow_version_id?: string | null
  workflow_version_sha?: string | null
  source_name?: string | null
  is_test: boolean
  execution_started_at_utc: Date
  execution_started_at_et: Date
  // Field map extracted from trigger payload (see extractSightingFields)
  payload_fields: SightingPayloadFields
  // Set when persons upsert succeeds
  ssn?: string | null
  person_id?: string | null
}

export interface SightingPayloadFields {
  // identifiers
  subaccount_uuid?: string | null
  lead_uuid?: string | null
  external_partner_name?: string | null
  external_routing_code?: string | null
  external_exchange_status?: string | null
  offer_landing_page?: string | null
  // demographics
  state?: string | null
  zip?: string | null
  fico_tier?: string | null
  employment_status?: string | null
  education_level?: string | null
  rent_or_own?: string | null
  loan_purpose?: string | null
  income_pmt_frequency?: string | null
  annual_income?: number | null
  external_debt?: number | null
  loan_amount?: number | null
  // compliance
  tcpa_consent?: boolean | null
  fcra_consent?: boolean | null
  user_ip?: string | null
  user_agent?: string | null
}

export interface PersonsUpsertInput {
  organization_id: string
  ssn: string  // raw or formatted
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  dob?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  apt?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

export interface BidAttemptInsert {
  sighting_id: string
  trace_id: string
  execution_id: string
  partner_slug: string
  attempted_at_utc: Date
  attempted_at_et: Date
  responded_at_utc?: Date | null
  responded_at_et?: Date | null
  http_status?: number | null
  bid_cents?: number | null
  classification?: string | null   // 'accept' | 'decline' | 'no_bid' | 'transient' | 'permanent'
  decline_reason?: string | null
  resolver_type?: string | null    // 'formula' | 'matrix' | 'api'
  skip_reason?: string | null      // 'cap_hit' | 'circuit_open' | 'dedup' | 'inactive' | 'partner_inactive' | 'cap_exceeded' | 'duplicate' | 'bid_below_min' | 'rejected'
  is_test: boolean
}

export interface FinalizeSightingInput {
  sighting_id: string
  execution_id: string
  execution_started_at_utc: Date
  execution_finished_at_et: Date
  execution_ended_at_utc: Date
  duration_ms: number
  terminal_node_id?: string | null
  terminal_node_label?: string | null
  response_status_code?: number | null
  prospect_id?: string | null
  equifax_status?: string | null
  equifax_error_type?: string | null
  equifax_score?: number | null
  winning_partner_slug?: string | null
  winning_bid_cents?: number | null
  partners_attempted?: number | null
  partners_responded?: number | null
  reject_reason?: string | null
  outcome?: string | null   // 'successful' | 'completed' | 'failed' — mirrors workflow_executions.outcome
}

// ============================================================
// extractSightingFields
// ============================================================
// Pulls non-PII demographic / financial / source fields from the trigger
// payload. Field paths verified against the live Engine Bidding Workflow's
// `prospect_body` code node (Bidspoke workflow_versions table, 2026-04-30).
//
// The engine source only populates a subset; other sources (main flow, etc.)
// may populate additional fields (external_partner_name, external_debt, etc.)
// using best-guess paths. Any field not in payload yields null.
export function extractSightingFields(payload: unknown): SightingPayloadFields {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const personal = nested(p, 'personalInformation')
  const loan = nested(p, 'loanInformation')
  const mortgage = nested(p, 'mortgageInformation')
  const credit = nested(p, 'creditInformation')
  const financial = nested(p, 'financialInformation')
  const education = nested(p, 'educationInformation')
  const legal = nested(p, 'legalInformation')
  const session = nested(p, 'sessionInformation')

  return {
    subaccount_uuid:          asString(p.subAccountUuid),
    lead_uuid:                asString(p.leadUuid),
    // Best-guess paths for cross-workflow fields (engine source doesn't populate these).
    external_partner_name:    asString(p.externalPartnerName),
    external_routing_code:    asString(p.externalRoutingCode),
    external_exchange_status: asString(p.externalExchangeStatus),
    offer_landing_page:       asString(p.offerLandingPage),

    state:                    normalizeState(personal.state),
    zip:                      asString(personal.zipcode)?.slice(0, 5) ?? null,

    fico_tier:                asString(credit.providedCreditRating),
    employment_status:        asString(financial.employmentStatus),
    education_level:          asString(education.educationLevel),
    rent_or_own:              asString(mortgage.propertyStatus),
    loan_purpose:             asString(loan.purpose),
    income_pmt_frequency:     asString(financial.employmentPayFrequency),
    annual_income:            asNumber(financial.annualIncome),
    // Best-guess for external_debt; engine workflow doesn't capture it.
    external_debt:            asNumber(financial.externalDebtAmount ?? financial.externalDebt),
    loan_amount:              asNumber(loan.loanAmount),

    tcpa_consent:             asBool(legal.consentsToTcpa),
    fcra_consent:             asBool(legal.consentsToFcra),
    user_ip:                  asString(session.ipAddress),
    user_agent:               asString(session.userAgent),
  }
}

function nested(p: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = p[key]
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

// ============================================================
// extractPersonFields
// ============================================================
// PII for persons upsert. Field paths verified against the live Engine
// Bidding Workflow's prospect_body code node.
//
// Returns null fields when payload is missing them; upsertPerson will write
// what's present and leave the rest unencrypted.
export function extractPersonFields(
  payload: unknown,
): Omit<PersonsUpsertInput, 'organization_id'> | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const personal = nested(p, 'personalInformation')
  const ssn = asString(personal.ssn)
  if (!ssn) return null

  return {
    ssn,
    first_name:  asString(personal.firstName),
    middle_name: asString(personal.middleName),
    last_name:   asString(personal.lastName),
    dob:         asString(personal.dateOfBirth),
    email:       asString(personal.email),
    phone:       asString(personal.primaryPhone),
    street:      asString(personal.address1),
    apt:         asString(personal.address2),
    city:        asString(personal.city),
    state:       normalizeState(personal.state),
    zip:         asString(personal.zipcode),
  }
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number') return String(v)
  return null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1 || v === '1') return true
  if (v === 'false' || v === 0 || v === '0') return false
  return null
}

// US states + DC + territories, full name -> 2-letter code. Used to normalize a
// payload state into the VARCHAR(2) column so an unnormalized source (e.g. one
// sending "California") can't overflow the column and fail the whole insert.
const US_STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
}

// Normalizes a payload state to a 2-letter code (or null). Guarantees the result
// fits VARCHAR(2): a 2-letter input is uppercased and passed through, a full
// state name is mapped, anything else becomes null (field dropped, sighting kept)
// rather than overflowing the column and failing the insert (#91).
function normalizeState(v: unknown): string | null {
  const s = asString(v)
  if (!s) return null
  const trimmed = s.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase()
  return US_STATE_CODES[trimmed.toLowerCase()] ?? null
}

// ============================================================
// deriveRejectReason
// ============================================================
// Engine-derived reason for why a lead did not result in a bid.
// Returns null when winning_partner_slug is set (it's a bid, not a rejection).
//
// Order matters — earlier checks override later ones.
export function deriveRejectReason(input: {
  winning_partner_slug?: string | null
  response_status_code?: number | null
  terminal_node_type?: string | null
  terminal_node_label?: string | null
  terminal_node_handle?: string | null   // edge handle the run exited via (e.g. 'exit', 'no_winner')
  terminal_step_output?: unknown          // for code-error sentinels
  filter_rule_label?: string | null       // when terminal node is a filter, the rule that matched
}): string | null {
  if (input.winning_partner_slug) return null
  if ((input.response_status_code ?? 0) >= 500) return 'engine_error'

  if (input.terminal_node_type === 'filter' && input.terminal_node_handle === 'exit') {
    return input.filter_rule_label ? `filter:${input.filter_rule_label}` : 'filter_rejected'
  }
  if (input.terminal_node_type === 'bid_group' && input.terminal_node_handle === 'no_winner') {
    return 'all_partners_declined'
  }
  if (input.terminal_node_type === 'code') {
    // Code nodes that throw or return an error sentinel surface their namespace as the reason.
    const out = input.terminal_step_output as { _error?: unknown; expected?: unknown } | undefined
    if (out && (out._error || out.expected)) {
      return input.terminal_node_label ?? 'code_error'
    }
  }

  return input.terminal_node_label ?? 'unknown'
}

// ============================================================
// upsertPerson
// ============================================================
// Encrypts PII fields and upserts a row keyed by (organization_id, ssn_hash).
// On conflict, updates last_seen_at and any newly-populated fields.
export async function upsertPerson(
  supabase: SupabaseClient,
  input: PersonsUpsertInput,
  encryptionKey: string,
  pepper: string,
): Promise<string | null> {
  if (!input.ssn) return null

  const ssnDigits = input.ssn.replace(/\D/g, '')
  if (ssnDigits.length !== 9) return null

  const ssnHash = await hashSsn(ssnDigits, pepper)
  const ssnEnc = await encryptPii(formatSsn(ssnDigits), encryptionKey)

  // NOTE(#90): encryptPii returns raw iv||ciphertext bytes, but we base64 them
  // before insert. PostgREST sends that string to the BYTEA columns without a
  // \x prefix, so Postgres stores the *ASCII bytes of the base64 string*, not
  // the raw ciphertext. decryptPii expects raw bytes and will NOT round-trip a
  // row as stored. To read an existing row you must: pg bytea -> hex-decode ->
  // (ASCII base64) -> atob -> iv||ciphertext -> decryptPii. All ~952K rows are
  // in this format. This is intentionally left as-is: persons is write-only with
  // no reader today and is slated for truncation/abandonment (see the
  // "Stop writing the persons table" item in TODO.md / memory
  // project_persons_dead_weight_2026_06_01), which resolves #90. If persons is
  // ever kept as a live readable store, write proper \x-hex bytea here instead.
  const enc = async (v: string | null | undefined) =>
    v && v.length > 0 ? bytesToBase64(await encryptPii(v, encryptionKey)) : null

  const row = {
    organization_id: input.organization_id,
    ssn_hash: ssnHash,
    ssn_encrypted: bytesToBase64(ssnEnc),
    first_name_enc: await enc(input.first_name),
    middle_name_enc: await enc(input.middle_name),
    last_name_enc: await enc(input.last_name),
    dob_enc: await enc(input.dob),
    email_enc: await enc(input.email),
    phone_enc: await enc(input.phone),
    street_enc: await enc(input.street),
    apt_enc: await enc(input.apt),
    city: input.city ?? null,
    state: input.state ?? null,
    zip_enc: await enc(input.zip),
    last_seen_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('persons')
    .upsert(row, { onConflict: 'organization_id,ssn_hash' })
    .select('id')
    .single()

  if (error) {
    console.error('[lead-sightings] upsertPerson failed:', error.message)
    return null
  }
  return data?.id ?? null
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

// ============================================================
// insertSighting
// ============================================================
// Inserts a row in lead_sightings with outcome_state='in_flight'.
// Returns sighting_id on success, null on failure (caller continues anyway).
export async function insertSighting(
  supabase: SupabaseClient,
  input: SightingInsert,
): Promise<string | null> {
  const { id, payload_fields, execution_started_at_et, execution_started_at_utc, ...rest } = input
  const row = {
    id,
    trace_id: rest.trace_id,
    execution_id: rest.execution_id,
    workflow_id: rest.workflow_id,
    workflow_version_id: rest.workflow_version_id ?? null,
    workflow_version_sha: rest.workflow_version_sha ?? null,
    source_name: rest.source_name ?? null,
    is_test: rest.is_test,
    outcome_state: 'in_flight',
    execution_started_at_et: execution_started_at_et.toISOString(),
    execution_started_at_utc: execution_started_at_utc.toISOString(),
    // ssn is VARCHAR(11) (XXX-XX-XXXX). A non-conforming value from an
    // unnormalized source would overflow and fail the whole insert, so drop it
    // to null rather than truncate a (then-wrong) SSN (#91).
    ssn: rest.ssn && rest.ssn.length <= 11 ? rest.ssn : null,
    person_id: rest.person_id ?? null,
    ...payload_fields,
  }

  const { error } = await supabase.from('lead_sightings').insert(row)
  if (error) {
    console.error('[lead-sightings] insertSighting failed:', error.message)
    return null
  }
  return id
}

// ============================================================
// recordBidAttempt
// ============================================================
// One row per partner attempt (success, skip, or error). is_winner=false at
// insert; finalize hook flips the winner via UPDATE matching partner_slug.
export async function recordBidAttempt(
  supabase: SupabaseClient,
  input: BidAttemptInsert,
): Promise<void> {
  const row = {
    sighting_id: input.sighting_id,
    trace_id: input.trace_id,
    execution_id: input.execution_id,
    partner_slug: input.partner_slug,
    is_winner: false,
    attempted_at_utc: input.attempted_at_utc.toISOString(),
    attempted_at_et: input.attempted_at_et.toISOString(),
    responded_at_utc: input.responded_at_utc?.toISOString() ?? null,
    responded_at_et: input.responded_at_et?.toISOString() ?? null,
    duration_ms:
      input.responded_at_utc && input.attempted_at_utc
        ? input.responded_at_utc.getTime() - input.attempted_at_utc.getTime()
        : null,
    http_status: input.http_status ?? null,
    bid_cents: input.bid_cents ?? null,
    classification: input.classification ?? null,
    decline_reason: input.decline_reason ?? null,
    resolver_type: input.resolver_type ?? null,
    skip_reason: input.skip_reason ?? null,
    is_test: input.is_test,
  }

  const { error } = await supabase.from('lead_sighting_bids').insert(row)
  if (error) {
    console.error('[lead-sightings] recordBidAttempt failed:', error.message)
  }
}

// ============================================================
// finalizeSighting
// ============================================================
// Flips outcome_state to 'finalized', sets terminal node + response + bid
// summary + enrichment fields, and marks the winning bid row.
export async function finalizeSighting(
  supabase: SupabaseClient,
  input: FinalizeSightingInput,
): Promise<void> {
  const { sighting_id, execution_id, execution_started_at_utc, ...fields } = input

  const update = {
    outcome_state: 'finalized',
    execution_finished_at_et: fields.execution_finished_at_et.toISOString(),
    execution_ended_at_utc: fields.execution_ended_at_utc.toISOString(),
    duration_ms: fields.duration_ms,
    terminal_node_id: fields.terminal_node_id ?? null,
    terminal_node_label: fields.terminal_node_label ?? null,
    response_status_code: fields.response_status_code ?? null,
    prospect_id: fields.prospect_id ?? null,
    equifax_status: fields.equifax_status ?? null,
    equifax_error_type: fields.equifax_error_type ?? null,
    equifax_score: fields.equifax_score ?? null,
    winning_partner_slug: fields.winning_partner_slug ?? null,
    winning_bid_cents: fields.winning_bid_cents ?? null,
    partners_attempted: fields.partners_attempted ?? null,
    partners_responded: fields.partners_responded ?? null,
    reject_reason: fields.reject_reason ?? null,
    outcome: fields.outcome ?? null,
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase
    .from('lead_sightings')
    .update(update)
    .eq('id', sighting_id)
    .eq('execution_started_at_utc', execution_started_at_utc.toISOString())

  if (error) {
    console.error('[lead-sightings] finalizeSighting failed:', error.message)
    return
  }

  if (fields.winning_partner_slug) {
    // Also clear exported_at: if this bid was already exported with the insert-
    // time is_winner=false (an execution in flight at the nightly export instant),
    // the row's winner flag was corrected only in Supabase and would never reach
    // Snowflake. Nulling exported_at re-queues it for the next export, which
    // re-MERGEs the corrected flag (the MERGE is idempotent on id). In the common
    // case the bid hasn't exported yet, so exported_at is already null — a no-op.
    const { error: bidError } = await supabase
      .from('lead_sighting_bids')
      .update({ is_winner: true, exported_at: null })
      .eq('execution_id', execution_id)
      .eq('partner_slug', fields.winning_partner_slug)

    if (bidError) {
      console.error('[lead-sightings] finalize: mark winner failed:', bidError.message)
    }
  }
}

// ============================================================
// Helper: read enrichment data from ctx.steps for finalize
// ============================================================
export function extractEnrichment(steps: Record<string, StepOutput>): {
  prospect_id: string | null
  equifax_status: string | null
  equifax_error_type: string | null
  equifax_score: number | null
} {
  // Salesforce node namespace 'create_prospect' is the convention in the live
  // engine workflow. If renamed, update here. The Salesforce executor wraps
  // the API response under `body`, so the SF record id is at `output.body.id`.
  // Tolerate `output.id` too in case a different workflow's SF node returns
  // the id at the top level.
  const sfStep = steps.create_prospect
  const sfOut = sfStep?.status === 'completed' ? (sfStep.output as Record<string, unknown> | null) : null
  const sfBody = (sfOut?.body ?? null) as { id?: string } | null
  const prospect_id = sfBody?.id ?? (sfOut as { id?: string } | null)?.id ?? null

  // Equifax code node namespace 'equifax_credit_report' in the live workflow.
  // The engine workflow's code node returns the raw Equifax JSON, where the
  // FICO score lives at consumers.equifaxUSConsumerCreditReport[0].models[0].score.
  // Tolerate flatter shapes (top-level `score` / `fico`) for other workflows.
  const eqxStep = steps.equifax_credit_report
  let equifax_status: string | null = null
  let equifax_error_type: string | null = null
  let equifax_score: number | null = null

  if (eqxStep) {
    if (eqxStep.status === 'completed') {
      const out = (eqxStep.output ?? {}) as Record<string, unknown>
      const status = typeof out.status === 'string' ? out.status : 'success'
      equifax_status = status
      const consumers = (out.consumers ?? null) as { equifaxUSConsumerCreditReport?: Array<{ models?: Array<{ score?: unknown }> }> } | null
      const nestedScore = consumers?.equifaxUSConsumerCreditReport?.[0]?.models?.[0]?.score
      const score = (out.score ?? out.fico ?? nestedScore ?? null) as number | string | null
      equifax_score = typeof score === 'number' ? score : score ? Number(score) : null
      if (Number.isNaN(equifax_score as number)) equifax_score = null
    } else if (eqxStep.status === 'failed') {
      equifax_status = 'error'
      equifax_error_type = eqxStep.error_type ?? 'permanent'
    } else if (eqxStep.status === 'skipped') {
      equifax_status = 'skipped'
    }
  }

  return { prospect_id, equifax_status, equifax_error_type, equifax_score }
}

// ============================================================
// Helper: terminal node lookup from execution context
// ============================================================
export function findTerminalNode(
  ctx: ExecutionContext,
  nodes: NodeDefinition[],
): { id: string | null; label: string | null; type: string | null } {
  const ns = ctx.lastCompletedNamespace ?? null
  if (!ns) return { id: null, label: null, type: null }
  const node = nodes.find((n) => n.namespace === ns)
  if (!node) return { id: ns, label: ns, type: null }
  return { id: node.id, label: ns, type: node.type }
}

// ============================================================
// Helper: bid group summary
// ============================================================
// Scans step outputs for a Bid Group result (shape: {winner, all_bids, _route}).
// Returns the winner slug + bid cents and rough attempted/responded counts.
// Workflows without a bid_group node yield all-null summary.
export function extractBidGroupSummary(steps: Record<string, StepOutput>): {
  winner_slug: string | null
  winner_bid_cents: number | null
  attempted: number | null
  responded: number | null
} {
  for (const step of Object.values(steps)) {
    const out = step.output
    if (!out || typeof out !== 'object') continue
    const obj = out as Record<string, unknown>
    if (!('winner' in obj) || !('all_bids' in obj)) continue

    const winner = obj.winner as { partner?: string; bid?: number } | null
    const allBids = Array.isArray(obj.all_bids) ? (obj.all_bids as Array<Record<string, unknown>>) : []
    // `responded` = partners that actually returned a response. A timed-out or
    // errored attempt is synthesized with skipped:false but carries an `error`,
    // so guard on both — otherwise non-responders inflate the response rate.
    // (A genuine null-bid decline has no `error` and correctly counts.)
    const responded = allBids.filter((b) => !b.skipped && b.error === undefined).length

    return {
      winner_slug: winner?.partner ?? null,
      winner_bid_cents:
        typeof winner?.bid === 'number' ? Math.round(winner.bid * 100) : null,
      // `all_bids` already contains every attempt; `excluded` is a SUBSET of it
      // (all_bids minus the winner, or an alias of it in the no-winner case), so
      // adding the two double-counts. Count attempts from all_bids alone.
      attempted: allBids.length || null,
      responded: responded || null,
    }
  }
  return { winner_slug: null, winner_bid_cents: null, attempted: null, responded: null }
}
