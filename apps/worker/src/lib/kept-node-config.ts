/**
 * The outcome deciding node settings of each kept workflow against the canvas
 * mirror (#1662), judged in the same hourly run and paged in the same alert as
 * the kept scripts (engine-script-drift.ts).
 *
 * On 2026-09-30 the Liberty1 Click Handler's click_send success line was changed
 * on the canvas (version 12) and the committed definition went stale with
 * nothing to say so, because the script check reads code node scripts only.
 *
 * The committed side is the file each workflow was built from or wired by
 * (docs/workflows/...). A node is judged when its type has at least one watched
 * setting below; every other setting a committed node holds must be listed as
 * unwatched with its reason, which a test enforces, so a new setting is a
 * decision rather than a silent gap (L96).
 *
 * Per watched setting:
 *   equal on both sides, or absent on both      agree
 *   different                                   config_drift, with the first
 *                                               differing path and both values
 *   on the canvas, absent from the committed    not_committed: the repo has no
 *   file                                        record of it at all (its own
 *                                               finding, never an agreement)
 *   a vocabulary setting (buyer_select mode)    judged against the vocabulary,
 *                                               not the file: outside_allowed
 *   a retired setting (RETIRED_CONFIG_FIELDS)    retired_setting whenever the
 *   on the canvas at all                        canvas holds it: the node no
 *                                               longer reads it
 * A committed node absent from the canvas is missing_node, and one of another
 * type is type_changed. Object key order is not a difference; nothing else is
 * forgiven (L273).
 */
import { BUYER_SELECT_MODES } from '@bidspoke/buyer-profile'

export interface CommittedNode {
  namespace: string
  type: string
  config: Record<string, unknown>
}

/** One committed file and the nodes in it the canvas is judged against. */
export interface CommittedSource {
  /** The repo path, named in a page. */
  file: string
  nodes: readonly CommittedNode[]
}

export interface FieldRule {
  field: string
  /** Why this setting decides an outcome. */
  why: string
  /**
   * Set for a setting an operator moves on purpose between known values: the
   * canvas is judged against this list, never against the committed value.
   */
  allowed?: readonly string[]
}

export interface UnwatchedField {
  field: string
  /** Why a difference here is not a finding. */
  why: string
}

const RETRIES_IGNORED = 'the node runs once whatever this says and reports the value as ignored, so it decides nothing'
const RETRY_TUNING = 'how hard a call is retried and how long it may take, which an operator tunes; what the node does and writes is decided by the watched settings'
const SCRIPT = 'owned by the kept script check, which compares it byte for byte with apps/worker/src/engine/scripts/<folder>'

/**
 * The settings compared, per node type. Each decides who is sold to, what is
 * sent or written, or which way a lead routes.
 */
export const WATCHED_CONFIG_FIELDS: Readonly<Record<string, readonly FieldRule[]>> = {
  buyer_click_send: [
    { field: 'partner_id', why: 'the buyer the click is claimed, counted and sold for' },
    { field: 'prospect_id', why: 'the template for the sale key, so which record a click is claimed and stamped on' },
    { field: 'request_body', why: 'the template for what is posted to the buyer' },
    { field: 'state', why: "the template for the lead's state, which picks the buyer profile's route, so where the lead is posted (#1671)" },
  ],
  buyer_click_check: [
    { field: 'partner_id', why: 'the buyer whose profile decides whether the offer is made' },
    { field: 'population', why: 'which buyer population the profile is judged for' },
    { field: 'state', why: 'the template for the state the profile box is judged on' },
    { field: 'debt', why: 'the template for the debt figure the profile box is judged on' },
    { field: 'loan_amount', why: 'the template for the loan amount the profile box is judged on' },
  ],
  buyer_select: [
    {
      field: 'mode',
      why: 'decide_only rehearses and live sells; Dan moves it between the two during Stage B, so only a value outside the modes the node accepts is a finding',
      allowed: BUYER_SELECT_MODES,
    },
    { field: 'population', why: 'which buyers are considered at all' },
    { field: 'live_percent_env', why: 'the env var naming the share of leads sold live; the percent itself is operational and lives in that env var, not here' },
    { field: 'sell_off_when', why: 'the template deciding a lead is a sell off' },
    { field: 'bid_when_positive', why: 'the template gating a sale on a positive bid' },
    { field: 'lead_key', why: 'the template for the key a sale is claimed on, so two runs cannot sell one lead twice' },
    { field: 'state', why: 'the template for the state buyer profiles are judged on' },
    { field: 'debt', why: 'the template for the debt buyer profiles are judged on' },
    { field: 'loan_amount', why: 'the template for the loan amount buyer profiles are judged on' },
    { field: 'sale_payload', why: 'the body sold to the buyer, every templated and normalised field of it' },
  ],
  branch: [
    { field: 'branches', why: 'the conditions that route a lead down each branch' },
    { field: 'else_behavior', why: 'what happens to a lead no branch matched' },
  ],
  filter: [
    { field: 'condition', why: 'the condition a lead must meet to continue' },
    { field: 'operation', why: 'whether the condition continues or stops a lead' },
  ],
  salesforce: [
    { field: 'operation', why: 'create (when absent), update, upsert, query or apex, so whether and how Salesforce is written' },
    { field: 'object', why: 'the Salesforce object written' },
    { field: 'record_id', why: 'the template for the record written' },
    { field: 'body', why: 'the template for what is written' },
    { field: 'soql', why: 'the template for the query that finds the record' },
    { field: 'apex_path', why: 'the Apex endpoint called, so which Salesforce logic prices or writes the lead' },
    { field: 'apex_method', why: 'GET or POST to the Apex endpoint, so whether the body is sent at all' },
    { field: 'external_id_field', why: 'the field an upsert matches on, so which record is written' },
    { field: 'external_id_value', why: 'the template for the value an upsert matches on' },
    { field: 'expected_errors', why: 'the Salesforce rejections that end a lead as rejected rather than failed, and what the caller is told when they do' },
    { field: 'injected_fields', why: 'fields merged into what is written, overriding the body on a collision' },
  ],
  response: [
    { field: 'status_code', why: 'the status the caller is answered with' },
    { field: 'body', why: 'what the caller is told happened' },
    { field: 'headers', why: 'the headers the caller is answered with' },
    { field: 'continue_after_response', why: 'whether the writes after the answer run at all' },
  ],
}

/** Every other setting a committed kept node holds, with why it is not compared. */
export const UNWATCHED_CONFIG_FIELDS: Readonly<Record<string, readonly UnwatchedField[]>> = {
  buyer_click_send: [
    { field: 'alert_over_percent', why: 'when the over cap notice pages, an alert threshold an operator tunes; it decides no sale' },
    { field: 'retries', why: RETRIES_IGNORED },
    { field: 'daily_lead_cap', why: 'ignored by the node and reported as such; the cap lives on the buyer profile' },
  ],
  buyer_select: [{ field: 'retries', why: RETRIES_IGNORED }],
  branch: [
    { field: 'retries', why: RETRY_TUNING },
    { field: 'timeout_ms', why: RETRY_TUNING },
  ],
  filter: [{ field: 'retries', why: RETRY_TUNING }],
  salesforce: [
    { field: 'retries', why: RETRY_TUNING },
    { field: 'timeout_ms', why: RETRY_TUNING },
    { field: 'transient_errors', why: 'which Salesforce errors are retried, which is retry tuning; the write itself is watched' },
  ],
  code: [
    { field: 'script', why: SCRIPT },
    { field: 'retries', why: RETRY_TUNING },
    { field: 'timeout_ms', why: RETRY_TUNING },
  ],
}

/**
 * Settings a node type no longer reads (#1671). A canvas holding one means
 * somebody expects it to do something it no longer does, so any value, even an
 * empty one, is a finding. The live Liberty1 canvas was cleared of both at
 * version 15 (2026-09-30).
 */
export interface RetiredField extends UnwatchedField {
  /** How to take it off the node on the canvas: the only fix, since the node ignores it (L111). */
  remove: string
}

const REMOVE_CLICK_SEND_LEFTOVER = 'open the step, press Remove the old address and success line, and save the workflow'

export const RETIRED_CONFIG_FIELDS: Readonly<Record<string, readonly RetiredField[]>> = {
  buyer_click_send: [
    { field: 'request_url', why: "where a click goes is the buyer profile's Click delivery since #1671", remove: REMOVE_CLICK_SEND_LEFTOVER },
    { field: 'success_pattern', why: "the reply that counts as sold is the buyer profile's Click delivery success reply since #1671", remove: REMOVE_CLICK_SEND_LEFTOVER },
  ],
}

type VerdictBase = { workflow: string; namespace: string; file: string }
export type ConfigVerdict =
  | (VerdictBase & { state: 'agree' })
  | (VerdictBase & { state: 'config_drift'; field: string; path: string; committed: string; canvas: string })
  | (VerdictBase & { state: 'not_committed'; field: string; canvas: string })
  | (VerdictBase & { state: 'outside_allowed'; field: string; canvas: string; allowed: readonly string[] })
  | (VerdictBase & { state: 'retired_setting'; field: string; canvas: string; why: string; remove: string })
  | (VerdictBase & { state: 'missing_node'; nodeType: string })
  | (VerdictBase & { state: 'type_changed'; committedType: string; canvasType: string })

const NOT_SET = '(not set)'
const MAX_VALUE = 120

/** A value for Slack: JSON, so a string reads quoted and an absent value reads as such, never a whole template. */
function render(value: unknown): string {
  if (value === undefined) return NOT_SET
  const text = JSON.stringify(value)
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 3)}...` : text
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The first path at which two values differ, or null when they are equal. Object key order is not a difference. */
function firstDifference(a: unknown, b: unknown, path: string): { path: string; a: unknown; b: unknown } | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[key], b[key], `${path}.${key}`)
      if (d) return d
    }
    return null
  }
  return Object.is(a, b) ? null : { path, a, b }
}

interface CanvasNodeLike {
  namespace?: unknown
  type?: unknown
  config?: unknown
}

export function judgeKeptConfig(sources: readonly CommittedSource[], definition: { nodes?: unknown }, workflow: string): ConfigVerdict[] {
  const canvasNodes = Array.isArray(definition.nodes) ? (definition.nodes as CanvasNodeLike[]) : []
  const out: ConfigVerdict[] = []
  for (const source of sources) {
    for (const committed of source.nodes) {
      const rules = WATCHED_CONFIG_FIELDS[committed.type] ?? []
      if (rules.length === 0) continue
      const base = { workflow, namespace: committed.namespace, file: source.file }
      const canvas = canvasNodes.find((n) => n.namespace === committed.namespace)
      if (!canvas) {
        out.push({ ...base, state: 'missing_node', nodeType: committed.type })
        continue
      }
      if (canvas.type !== committed.type) {
        out.push({ ...base, state: 'type_changed', committedType: committed.type, canvasType: String(canvas.type) })
        continue
      }
      const canvasConfig = isObject(canvas.config) ? canvas.config : {}
      const found: ConfigVerdict[] = []
      for (const rule of rules) {
        const onCanvas = canvasConfig[rule.field]
        const inRepo = committed.config[rule.field]
        if (rule.allowed) {
          if (typeof onCanvas !== 'string' || !rule.allowed.includes(onCanvas)) {
            found.push({ ...base, state: 'outside_allowed', field: rule.field, canvas: render(onCanvas), allowed: [...rule.allowed] })
          }
          continue
        }
        if (inRepo === undefined && onCanvas !== undefined) {
          found.push({ ...base, state: 'not_committed', field: rule.field, canvas: render(onCanvas) })
          continue
        }
        const d = firstDifference(inRepo, onCanvas, rule.field)
        if (d) found.push({ ...base, state: 'config_drift', field: rule.field, path: d.path, committed: render(d.a), canvas: render(d.b) })
      }
      for (const retired of RETIRED_CONFIG_FIELDS[committed.type] ?? []) {
        if (canvasConfig[retired.field] !== undefined) found.push({ ...base, state: 'retired_setting', field: retired.field, canvas: render(canvasConfig[retired.field]), why: retired.why, remove: retired.remove })
      }
      out.push(...(found.length > 0 ? found : [{ ...base, state: 'agree' as const }]))
    }
  }
  return out
}

export function describeConfigVerdict(v: ConfigVerdict): string {
  switch (v.state) {
    case 'config_drift':
      return `${v.workflow}, ${v.namespace}: the canvas setting ${v.path} differs from ${v.file}. Committed: ${v.committed}. Canvas: ${v.canvas}.`
    case 'not_committed':
      return `${v.workflow}, ${v.namespace}: the canvas holds ${v.field} ${v.canvas}, and the setting is not in ${v.file}, so the repo has no record of it.`
    case 'outside_allowed':
      return `${v.workflow}, ${v.namespace}: ${v.field} on the canvas is ${v.canvas}, which is none of ${v.allowed.join(', ')}.`
    case 'retired_setting':
      return `${v.workflow}, ${v.namespace}: the canvas holds ${v.field} ${v.canvas}, a setting the node no longer reads: ${v.why}. To remove it, ${v.remove}.`
    case 'missing_node':
      return `${v.workflow}, ${v.namespace}: the workflow has no node with this namespace, while ${v.file} holds a ${v.nodeType} node of that name.`
    case 'type_changed':
      return `${v.workflow}, ${v.namespace}: the node is a ${v.canvasType} on the canvas and a ${v.committedType} in ${v.file}.`
    case 'agree':
      return `${v.workflow}, ${v.namespace}: the canvas settings agree with ${v.file}.`
  }
}
