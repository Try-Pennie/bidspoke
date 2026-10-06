/**
 * What a Pipedream workflow needs that Bidspoke does not have yet (#1710, plan 0.5).
 *
 * Read from the export alone: the triggers, every step (top level and every
 * deployment, which are the live if/else branches), the code inside code steps
 * and the workflow settings. Each need maps to the plan phase that supplies it
 * (CAPABILITY_PHASE) and carries the evidence that raised it, so the unlock table
 * can say why a workflow waits on a phase.
 *
 * These are ESTIMATES by design: the plan says the unlock table is re-derived as
 * each phase lands, and its later inputs (the real save validation refusals, the
 * approved library set, the catalogue's mapped keys) do not exist yet. Every rule
 * below says what it reads. Where a rule is a judgement it says so:
 * - `axios` and `@pipedream/platform` imports are counted as convertible to fetch
 *   by the converter (Phase 9), not as a library need;
 * - a timeout set above 30 seconds is NOT a need, only a reported fact
 *   (raisedTimeoutSeconds): on the 2026-09-30 export it was the only long run
 *   evidence for 100 of 320 workflows, and a raised ceiling says nothing about
 *   how long runs really take. Run history decides that, per workflow, at port;
 * - a call to a `*.m.pipedream.net` address is another Pipedream workflow, so it
 *   needs sub workflow calls (Phase 7);
 * - every registry step that is not a web request, a response, an end, a delay
 *   or a data store needs a connection or catalogue entry (Phase 3).
 */
import type { PipedreamStep, PipedreamWorkflow } from '../instrument/instrument.ts'

export type Capability =
  | 'code_runtime'
  | 'connections'
  | 'schedules'
  | 'data_stores'
  | 'long_runs'
  | 'request_access'
  | 'non_http_triggers'
  | 'runner'

/** The plan phase (Discussion #1684) that supplies each capability. */
export const CAPABILITY_PHASE: Record<Capability, string> = {
  code_runtime: 'Phase 2 code runtime',
  connections: 'Phase 3 catalogue, connections and Salesforce orgs',
  schedules: 'Phase 1 schedules and run engine',
  data_stores: 'Phase 4 data stores',
  long_runs: 'Phase 7 long runs, delays, retries, limits, sub workflows',
  request_access: 'Phase 5 request access and token login',
  non_http_triggers: 'Phase 6 non HTTP triggers',
  runner: 'Phase 8 runner',
}

export interface WorkflowNeeds {
  /** Each capability needed, with the evidence that raised it, in the order found. */
  needs: Map<Capability, string[]>
  /** Web request steps whose settings the export redacted, so they must be read off Pipedream. */
  redactedHttpSteps: number
  /** The workflow carries `_filter` rules, which the converter must recover. */
  filterRules: boolean
  /** More than one enabled trigger, so it ports as a split workflow. */
  multiTrigger: boolean
  /** Signs it belongs in the money lane: a bidding name or a credit or partner step. */
  biddingSignals: string[]
  /** The run timeout when set above Pipedream's default 30 seconds, else null. Reported, not a need. */
  raisedTimeoutSeconds: number | null
}

const BUILT_IN_KEYS = new Set(['http-custom-request', 'http-post-request', 'http-get-request', 'http-return-http-response', 'end-end-workflow'])
const CONVERTIBLE_IMPORTS = new Set(['axios', '@pipedream/platform'])
const RUNNER_IMPORT = /^(ssh2|ssh2-sftp-client|basic-ftp|ftp|puppeteer|puppeteer-core|puppeteer-extra|puppeteer-extra-plugin-stealth|@sparticuz\/chromium|playwright|playwright-core)(@.*)?$/
const IMPORT = /(?:\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?|\brequire\(\s*|\bimport\(\s*)["']([^"']+)["']/g
const BIDDING_KEY = /^(equifax-|tripoint$|eligibility_scout$|gigfi-|lendswift-|pennie-main-flow$)/
const BIDDING_NAME = /\bbid(s|ding)?\b/i
const REQUEST_PARTS = /\btrigger\.event\.(headers|query|method|bodyRaw|url)\b/

/** A module name without a trailing @version, which Pipedream accepts (`axios@1.6.0`, `@pipedream/platform@3.0.3`). */
const withoutVersion = (mod: string): string => {
  const at = mod.indexOf('@', mod.startsWith('@') ? 1 : 0)
  return at === -1 ? mod : mod.slice(0, at)
}

const codeOf = (s: PipedreamStep): string | null => {
  const uses = (s as { uses?: unknown }).uses
  return uses && typeof uses === 'object' && typeof (uses as { code?: unknown }).code === 'string' ? (uses as { code: string }).code : null
}
const keyOf = (s: PipedreamStep): string | null => {
  const k = (s as { component_key?: unknown }).component_key
  return typeof k === 'string' ? k : null
}

export function allSteps(wf: PipedreamWorkflow): PipedreamStep[] {
  return [...(wf.steps ?? []), ...Object.values(wf.deployments ?? {}).flatMap((d) => d.steps ?? [])]
}

export function workflowNeeds(wf: PipedreamWorkflow): WorkflowNeeds {
  const needs = new Map<Capability, string[]>()
  const need = (c: Capability, why: string) => {
    const list = needs.get(c) ?? []
    if (!list.includes(why)) list.push(why)
    needs.set(c, list)
  }

  const triggers = ((wf.triggers ?? []) as Array<{ type?: unknown; disabled?: unknown }>).filter((t) => t.disabled !== true)
  const http = triggers.some((t) => t.type === 'http')
  for (const t of triggers) {
    if (t.type === 'timer') need('schedules', 'trigger timer')
    else if (t.type !== 'http') need('non_http_triggers', `trigger ${String(t.type)}`)
  }

  const settings = wf.settings ?? {}
  if (settings.auto_retry === true) need('long_runs', 'setting auto_retry')
  for (const s of ['concurrency', 'rate_limit', 'max_event_queue_size']) if (settings[s] !== undefined && settings[s] !== null) need('long_runs', `setting ${s}`)
  const raisedTimeoutSeconds = typeof settings.lambda_timeout === 'number' && settings.lambda_timeout > 30 ? settings.lambda_timeout : null

  let redactedHttpSteps = 0
  const biddingSignals: string[] = []
  if (typeof wf.name === 'string' && BIDDING_NAME.test(wf.name)) biddingSignals.push('name')

  for (const step of allSteps(wf)) {
    const key = keyOf(step)
    const text = JSON.stringify(step)
    if (key !== null) {
      if (key.startsWith('data_stores-')) need('data_stores', `step ${key}`)
      else if (key.startsWith('delay-')) need('long_runs', `step ${key}`)
      else if (!BUILT_IN_KEYS.has(key)) need('connections', `step ${key}`)
      if (key.startsWith('http-') && text.includes('<redacted>')) redactedHttpSteps++
      if (BIDDING_KEY.test(key) && !biddingSignals.includes(`step ${key}`)) biddingSignals.push(`step ${key}`)
    }
    if (http) {
      const m = REQUEST_PARTS.exec(text)
      if (m) need('request_access', `reads trigger.event.${m[1]}`)
    }
    if (/[\w-]+\.m\.pipedream\.net/.test(text)) need('long_runs', 'calls another Pipedream workflow')

    const code = codeOf(step)
    if (code === null) continue
    for (const m of code.matchAll(IMPORT)) {
      const mod = m[1]
      if (CONVERTIBLE_IMPORTS.has(withoutVersion(mod))) continue
      if (RUNNER_IMPORT.test(mod)) need('runner', `imports ${mod}`)
      else need('code_runtime', `imports ${mod}`)
    }
    if (/\bBuffer\s*\./.test(code)) need('code_runtime', 'uses Buffer')
    if (/\$auth\b|type:\s*["']app["']/.test(code)) need('connections', 'app login in code')
    if (/type:\s*["']data_store["']|\$\.service\.db\b/.test(code)) need('data_stores', 'data store in code')
    if (/\$\.flow\.(delay|rerun)\b/.test(code)) need('long_runs', 'code delays or reruns the run')
  }

  return {
    needs,
    redactedHttpSteps,
    filterRules: JSON.stringify(wf).includes('"_filter"') || allSteps(wf).some((s) => (codeOf(s) ?? '').includes('_filter')),
    multiTrigger: triggers.length > 1,
    biddingSignals,
    raisedTimeoutSeconds,
  }
}
