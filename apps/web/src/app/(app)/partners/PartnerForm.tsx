'use client'

import { useState, useEffect, useRef } from 'react'
import type { Partner, PartnerBody, PartnerUuid } from '@/lib/api'
import { api } from '@/lib/api'
import { Save, Trash2, Loader2, Plus, X, Check } from 'lucide-react'

// ── Signal rule builder ───────────────────────────────────────────────────────

type RuleKind = 'body' | 'status'
type BodyCondition = 'equals' | 'contains' | 'present'
type StatusCondition = 'contains' | 'present'
type SignalCategory = 'rejection' | 'transient' | 'permanent'

interface BodyRule   { id: string; kind: 'body';   field: string; condition: BodyCondition;   value: string }
interface StatusRule { id: string; kind: 'status'; code: string;  bodyField: string; condition: StatusCondition; value: string }
type Rule = BodyRule | StatusRule
type SignalRules = Record<SignalCategory, Rule[]>

interface FormSnapshot {
  name: string; apiEndpoint: string; cfSecretKey: string; isActive: boolean
  priority: string; dailyCap: string; minBid: string; bidFormula: string
  dedupEndpoint: string; circuitEnabled: boolean; circuitThreshold: string
  circuitWindow: string; circuitCooldown: string; signalRules: SignalRules
  alertTransient: boolean; alertPermanent: boolean
  sellOffOfferTitle: string; sellOffOfferDetails: string
}

function uid() { return Math.random().toString(36).slice(2) }
function emptyBody(): BodyRule   { return { id: uid(), kind: 'body',   field: '',   condition: 'equals',   value: '' } }
function emptyStatus(): StatusRule { return { id: uid(), kind: 'status', code: '',    bodyField: '',         condition: 'contains', value: '' } }

function parseRules(raw: unknown): SignalRules {
  const result: SignalRules = { rejection: [], transient: [], permanent: [] }
  if (!raw || typeof raw !== 'object') return result
  const obj = raw as Record<string, unknown>
  const map: [string, SignalCategory][] = [
    ['rejection_signals', 'rejection'],
    ['transient_signals', 'transient'],
    ['permanent_signals', 'permanent'],
  ]
  for (const [key, cat] of map) {
    if (!Array.isArray(obj[key])) continue
    for (const sig of obj[key] as Record<string, unknown>[]) {
      if (sig.field != null) {
        let condition: BodyCondition = 'equals'
        let value = ''
        if (sig.present === true)      { condition = 'present' }
        else if (sig.contains != null) { condition = 'contains'; value = String(sig.contains) }
        else if (sig.equals != null)   { value = String(sig.equals) }
        result[cat].push({ id: uid(), kind: 'body', field: String(sig.field), condition, value })
      } else if (sig.status_code != null || sig.body_field != null || sig.header != null) {
        let condition: StatusCondition = 'contains'
        let value = ''
        if (sig.present === true)      { condition = 'present' }
        else if (sig.contains != null) { value = String(sig.contains) }
        result[cat].push({
          id: uid(), kind: 'status',
          code:      sig.status_code != null ? String(sig.status_code) : '',
          bodyField: String(sig.body_field ?? sig.header ?? ''),
          condition, value,
        })
      }
    }
  }
  return result
}

function serializeRules(rules: SignalRules): unknown {
  const map: [SignalCategory, string][] = [
    ['rejection', 'rejection_signals'],
    ['transient', 'transient_signals'],
    ['permanent', 'permanent_signals'],
  ]
  const result: Record<string, unknown[]> = {}
  let hasAny = false
  for (const [cat, key] of map) {
    const signals: unknown[] = []
    for (const r of rules[cat]) {
      if (r.kind === 'body' && r.field.trim()) {
        if      (r.condition === 'present')  signals.push({ field: r.field, present: true })
        else if (r.condition === 'contains') signals.push({ field: r.field, contains: r.value })
        else                                 signals.push({ field: r.field, equals: r.value })
      } else if (r.kind === 'status' && (r.code.trim() || r.bodyField.trim())) {
        const obj: Record<string, unknown> = {}
        if (r.code.trim())      obj.status_code = parseInt(r.code)
        if (r.bodyField.trim()) obj.body_field   = r.bodyField
        if (r.condition === 'present')        obj.present  = true
        else if (r.value.trim())              obj.contains = r.value
        signals.push(obj)
      }
    }
    if (signals.length > 0) { result[key] = signals; hasAny = true }
  }
  return hasAny ? result : null
}

const SIGNAL_SECTIONS: { cat: SignalCategory; label: string; desc: string }[] = [
  { cat: 'rejection', label: 'Rejection',      desc: 'Partner declined the lead. Logged as a business rejection, never retried.' },
  { cat: 'transient', label: 'Transient error', desc: 'Temporary failure. Will be retried according to the workflow retry policy.' },
  { cat: 'permanent', label: 'Permanent error', desc: 'Unrecoverable failure. No retry, triggers alerts.' },
]

const inputCls = 'rounded border border-gray-200 bg-white px-2 py-1 text-sm text-graphite placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-p-blue-light'

function RuleRow({ rule, onChange, onRemove, removing }: {
  rule: Rule
  onChange: (r: Rule) => void
  onRemove: () => void
  removing?: boolean
}) {
  return (
    <div className={`rule-row flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2${removing ? ' rule-row-exiting' : ''}`}>
      <select
        value={rule.kind}
        onChange={(e) => {
          const k = e.target.value as RuleKind
          onChange(k === 'body' ? { ...emptyBody(), id: rule.id } : { ...emptyStatus(), id: rule.id })
        }}
        className={`${inputCls} flex-shrink-0`}
      >
        <option value="body">Body field</option>
        <option value="status">HTTP status</option>
      </select>

      {rule.kind === 'body' ? (
        <>
          <input
            value={rule.field}
            onChange={(e) => onChange({ ...rule, field: e.target.value })}
            placeholder="field"
            className={`${inputCls} w-28`}
          />
          <select
            value={rule.condition}
            onChange={(e) => onChange({ ...rule, condition: e.target.value as BodyCondition })}
            className={`${inputCls} flex-shrink-0`}
          >
            <option value="equals">equals</option>
            <option value="contains">contains</option>
            <option value="present">is present</option>
          </select>
          {rule.condition !== 'present' && (
            <input
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder="value"
              className={`${inputCls} min-w-0 flex-1`}
            />
          )}
        </>
      ) : (
        <>
          <input
            value={rule.code}
            onChange={(e) => onChange({ ...rule, code: e.target.value })}
            placeholder="status"
            type="number"
            className={`${inputCls} w-20`}
          />
          <input
            value={rule.bodyField}
            onChange={(e) => onChange({ ...rule, bodyField: e.target.value })}
            placeholder="body field"
            className={`${inputCls} w-28`}
          />
          <select
            value={rule.condition}
            onChange={(e) => onChange({ ...rule, condition: e.target.value as StatusCondition })}
            className={`${inputCls} flex-shrink-0`}
          >
            <option value="contains">contains</option>
            <option value="present">is present</option>
          </select>
          {rule.condition !== 'present' && (
            <input
              value={rule.value}
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
              placeholder="value"
              className={`${inputCls} min-w-0 flex-1`}
            />
          )}
        </>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="ml-auto flex-shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function SignalRuleBuilder({ value, onChange }: { value: SignalRules; onChange: (v: SignalRules) => void }) {
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const valueRef = useRef(value)
  valueRef.current = value

  function update(cat: SignalCategory, id: string, rule: Rule) {
    onChange({ ...value, [cat]: value[cat].map((r) => (r.id === id ? rule : r)) })
  }
  function remove(cat: SignalCategory, id: string) {
    setRemovingIds((prev) => new Set([...prev, id]))
    setTimeout(() => {
      const cur = valueRef.current
      onChange({ ...cur, [cat]: cur[cat].filter((r) => r.id !== id) })
      setRemovingIds((prev) => { const s = new Set(prev); s.delete(id); return s })
    }, 150)
  }
  function add(cat: SignalCategory) {
    onChange({ ...value, [cat]: [...value[cat], emptyBody()] })
  }

  return (
    <div className="space-y-5">
      {SIGNAL_SECTIONS.map(({ cat, label, desc }) => (
        <div key={cat}>
          <div className="mb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700">{label}</p>
              <p className="text-xs text-gray-400">{desc}</p>
            </div>
            <button
              type="button"
              onClick={() => add(cat)}
              className="flex flex-shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-p-blue-dark hover:bg-p-blue-light"
            >
              <Plus className="h-3 w-3" />
              Add rule
            </button>
          </div>
          {value[cat].length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
              No rules. Uses default HTTP status classification.
            </p>
          ) : (
            <div className="space-y-1.5">
              {value[cat].map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  removing={removingIds.has(rule.id)}
                  onChange={(r) => update(cat, rule.id, r)}
                  onRemove={() => remove(cat, rule.id)}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Form field primitives ─────────────────────────────────────────────────────

interface Props {
  partner?: Partner
  onSave: (body: PartnerBody, id?: string) => Promise<void>
  onCancel: () => void
  onDelete?: (id: string) => void
  confirmingDelete?: boolean
  onConfirmDelete?: () => void
  onCancelDelete?: () => void
  deleting?: boolean
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text', mono }: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light ${mono ? 'font-mono' : ''}`}
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p-blue-dark focus-visible:ring-offset-1 ${checked ? 'bg-p-blue-dark' : 'bg-gray-200'}`}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-4 text-xs font-semibold text-gray-500">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

// ── Main form ─────────────────────────────────────────────────────────────────

type SaveState = 'idle' | 'saving' | 'saved'

export default function PartnerForm({
  partner,
  onSave,
  onCancel,
  onDelete,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  deleting,
}: Props) {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [undoSnapshot, setUndoSnapshot] = useState<FormSnapshot | null>(null)
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0)

  const [name, setName] = useState(partner?.name ?? '')
  const [slug, setSlug] = useState(partner?.slug ?? '')
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)

  function handleNameChange(value: string) {
    setName(value)
    if (!slugManuallyEdited) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    }
  }
  const [apiEndpoint, setApiEndpoint] = useState(partner?.api_endpoint ?? '')
  const [cfSecretKey, setCfSecretKey] = useState(partner?.cf_secret_key ?? '')
  const [isActive, setIsActive] = useState(partner?.is_active ?? true)
  const [priority, setPriority] = useState(String(partner?.priority ?? 0))

  const [dailyCap, setDailyCap] = useState(partner?.daily_cap != null ? String(partner.daily_cap) : '')
  const [minBid, setMinBid] = useState(partner?.min_bid != null ? String(partner.min_bid) : '')
  const [bidFormula, setBidFormula] = useState(partner?.bid_formula ?? '')
  const [dedupEndpoint, setDedupEndpoint] = useState(partner?.dedup_endpoint ?? '')

  const [circuitEnabled, setCircuitEnabled] = useState(partner?.circuit_enabled ?? true)
  const [circuitThreshold, setCircuitThreshold] = useState(String(partner?.circuit_error_threshold ?? 5))
  const [circuitWindow, setCircuitWindow] = useState(String(partner?.circuit_window_seconds ?? 60))
  const [circuitCooldown, setCircuitCooldown] = useState(String(partner?.circuit_cooldown_seconds ?? 300))

  const [signalRules, setSignalRules] = useState<SignalRules>(() => parseRules(partner?.response_classification))

  const defaultAlertConfig = partner?.alert_config as { transient_errors?: { alert?: boolean }; permanent_errors?: { alert?: boolean } } | null | undefined
  const [alertTransient, setAlertTransient] = useState(defaultAlertConfig?.transient_errors?.alert !== false)
  const [alertPermanent, setAlertPermanent] = useState(defaultAlertConfig?.permanent_errors?.alert !== false)

  const [sellOffOfferTitle, setSellOffOfferTitle] = useState(partner?.sell_off_offer_title ?? '')
  const [sellOffOfferDetails, setSellOffOfferDetails] = useState(partner?.sell_off_offer_details ?? '')

  const [uuids, setUuids] = useState<PartnerUuid[]>([])
  const [newUuid, setNewUuid] = useState('')
  const [addingUuid, setAddingUuid] = useState(false)
  const [uuidError, setUuidError] = useState<string | null>(null)
  const [removingUuidId, setRemovingUuidId] = useState<string | null>(null)

  useEffect(() => {
    if (!partner) return
    api.partnerUuids.list()
      .then((all) => setUuids(all.filter((u) => u.partner_slug === partner.slug)))
      .catch(() => {})
  }, [partner])

  // Undo countdown
  useEffect(() => {
    if (undoSecondsLeft <= 0) return
    const t = setTimeout(() => {
      setUndoSecondsLeft((s) => {
        if (s <= 1) { setUndoSnapshot(null); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearTimeout(t)
  }, [undoSecondsLeft])

  function captureSnapshot(): FormSnapshot {
    return { name, apiEndpoint, cfSecretKey, isActive, priority, dailyCap, minBid, bidFormula, dedupEndpoint, circuitEnabled, circuitThreshold, circuitWindow, circuitCooldown, signalRules, alertTransient, alertPermanent, sellOffOfferTitle, sellOffOfferDetails }
  }

  function restoreSnapshot(snap: FormSnapshot) {
    setName(snap.name); setApiEndpoint(snap.apiEndpoint); setCfSecretKey(snap.cfSecretKey)
    setIsActive(snap.isActive); setPriority(snap.priority)
    setDailyCap(snap.dailyCap); setMinBid(snap.minBid); setBidFormula(snap.bidFormula)
    setDedupEndpoint(snap.dedupEndpoint); setCircuitEnabled(snap.circuitEnabled)
    setCircuitThreshold(snap.circuitThreshold); setCircuitWindow(snap.circuitWindow)
    setCircuitCooldown(snap.circuitCooldown); setSignalRules(snap.signalRules)
    setAlertTransient(snap.alertTransient); setAlertPermanent(snap.alertPermanent)
    setSellOffOfferTitle(snap.sellOffOfferTitle); setSellOffOfferDetails(snap.sellOffOfferDetails)
  }

  function handleUndo() {
    if (!undoSnapshot) return
    restoreSnapshot(undoSnapshot)
    setUndoSnapshot(null)
    setUndoSecondsLeft(0)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const snapshot = captureSnapshot()
    setSaveState('saving')
    try {
      const body: PartnerBody = {
        name,
        slug: partner ? undefined : slug,
        api_endpoint: apiEndpoint || null,
        cf_secret_key: cfSecretKey || null,
        is_active: isActive,
        priority: parseInt(priority) || 0,
        daily_cap: dailyCap ? parseInt(dailyCap) : null,
        min_bid: minBid ? parseFloat(minBid) : null,
        bid_formula: bidFormula || null,
        dedup_endpoint: dedupEndpoint || null,
        circuit_enabled: circuitEnabled,
        circuit_error_threshold: parseInt(circuitThreshold) || 5,
        circuit_window_seconds: parseInt(circuitWindow) || 60,
        circuit_cooldown_seconds: parseInt(circuitCooldown) || 300,
        response_classification: serializeRules(signalRules),
        alert_config: {
          transient_errors: { alert: alertTransient },
          permanent_errors: { alert: alertPermanent },
        },
        sell_off_offer_title: sellOffOfferTitle || null,
        sell_off_offer_details: sellOffOfferDetails || null,
      }
      await onSave(body, partner?.id)
      setSaveState('saved')
      if (!isNew) {
        setUndoSnapshot(snapshot)
        setUndoSecondsLeft(5)
      }
      setTimeout(() => setSaveState('idle'), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save partner')
      setSaveState('idle')
    }
  }

  const isNew = !partner

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          {isNew
            ? <h2 className="text-lg font-medium text-gray-400">New partner</h2>
            : <h2 className="text-2xl font-bold text-graphite">{name || <span className="text-gray-300">Unnamed</span>}</h2>
          }
          {!isNew && (
            <p className="mt-0.5 font-mono text-sm text-gray-400">{partner.slug}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && onDelete && (
            confirmingDelete ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onConfirmDelete}
                  disabled={deleting}
                  className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  onClick={onCancelDelete}
                  className="text-sm text-gray-400 hover:text-gray-600"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onDelete(partner.id)}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
          >
            Cancel
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">

        <Section title="Identity">
          <Field label="Name" hint="Display name shown in the UI.">
            <Input value={name} onChange={handleNameChange} placeholder="Tripoint" />
          </Field>
          {isNew && (
            <Field
              label="Slug"
              hint="Lowercase identifier used in logs and workflow references. Cannot be changed after creation."
            >
              <Input
                value={slug}
                onChange={(v) => { setSlug(v); setSlugManuallyEdited(true) }}
                placeholder="tripoint"
                mono
              />
            </Field>
          )}
          <div className="flex items-center gap-6">
            <Field label="Priority">
              <Input value={priority} onChange={setPriority} type="number" placeholder="0" />
            </Field>
            <Field label="Status">
              <div className="flex items-center gap-2.5 pt-1">
                <Toggle checked={isActive} onChange={setIsActive} label="Partner active" />
                <span className="text-sm text-gray-700">{isActive ? 'Active' : 'Inactive'}</span>
              </div>
            </Field>
          </div>
        </Section>

        <Section title="API">
          <Field
            label="API endpoint"
            hint="URL to POST bids to. Leave blank for formula-only partners (e.g. Tripoint)."
          >
            <Input value={apiEndpoint} onChange={setApiEndpoint} placeholder="https://api.partner.com/bids" />
          </Field>
          <Field
            label="Auth secret name"
            hint="Name of the Cloudflare Workers secret holding this partner's API key, e.g. TRIPOINT_API_KEY."
          >
            <Input value={cfSecretKey} onChange={setCfSecretKey} placeholder="TRIPOINT_API_KEY" mono />
          </Field>
          <Field
            label="Dedup endpoint"
            hint="Optional. Called before each bid to check if this lead has already been sold to this partner."
          >
            <Input value={dedupEndpoint} onChange={setDedupEndpoint} placeholder="https://api.partner.com/dedup" />
          </Field>
        </Section>

        <Section title="Bidding">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Daily cap" hint="Max leads per day. Leave blank for unlimited.">
              <Input value={dailyCap} onChange={setDailyCap} type="number" placeholder="∞" />
            </Field>
            <Field label="Minimum bid ($)" hint="Reject bids below this amount.">
              <Input value={minBid} onChange={setMinBid} type="number" placeholder="0.00" />
            </Field>
          </div>
          <Field
            label="Bid formula"
            hint="Arithmetic expression for the bid price. Use any numeric field from trigger.payload by name (e.g. debt_amount * 0.65). Supports standard operators (+, -, *, /, **) and Math functions (Math.floor, Math.min, Math.max, Math.round, Math.abs, Math.sqrt)."
          >
            <textarea
              value={bidFormula}
              onChange={(e) => setBidFormula(e.target.value)}
              placeholder="debt_amount * 0.65"
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            />
          </Field>
        </Section>

        <Section title="Circuit breaker">
          <div className="flex items-center gap-2.5">
            <Toggle checked={circuitEnabled} onChange={setCircuitEnabled} label="Circuit breaker enabled" />
            <span className="text-sm text-gray-700">{circuitEnabled ? 'Enabled' : 'Disabled'}</span>
            <span className="text-gray-300">·</span>
            <p className="text-xs text-gray-400">
              Pauses bids to this partner after repeated failures, then retries automatically.
            </p>
          </div>
          <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${circuitEnabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="grid grid-cols-3 gap-4 pt-1">
                <Field label="Error threshold" hint="Errors before pausing.">
                  <Input value={circuitThreshold} onChange={setCircuitThreshold} type="number" placeholder="5" />
                </Field>
                <Field label="Window (seconds)" hint="Time period to count errors in.">
                  <Input value={circuitWindow} onChange={setCircuitWindow} type="number" placeholder="60" />
                </Field>
                <Field label="Pause duration (seconds)" hint="How long to wait before retrying.">
                  <Input value={circuitCooldown} onChange={setCircuitCooldown} type="number" placeholder="300" />
                </Field>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Response classification">
          <p className="text-xs text-gray-400">
            Override how this partner&apos;s responses are classified. Rules are evaluated before the defaults.
            Leave all sections empty to use default HTTP status–based classification.
          </p>
          <SignalRuleBuilder value={signalRules} onChange={setSignalRules} />
        </Section>

        <Section title="Sell-off offer copy">
          <p className="text-xs text-gray-400">
            Used by the Constants node in bidding workflows to populate sell-off offer fields for this partner.
          </p>
          <Field label="Sell-off offer title">
            <Input value={sellOffOfferTitle} onChange={setSellOffOfferTitle} placeholder="Get up to $50,000 in your account" />
          </Field>
          <Field label="Sell-off offer details">
            <textarea
              value={sellOffOfferDetails}
              onChange={(e) => setSellOffOfferDetails(e.target.value)}
              placeholder="Personal loans from $5,000–$100,000 with competitive rates."
              rows={3}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
            />
          </Field>
        </Section>

        {!isNew && (
          <Section title="Sub-account UUIDs">
            <p className="text-xs text-gray-400">
              External UUIDs that map to this partner. Used by the Constants node to resolve inbound sub-account IDs to partner slugs.
            </p>
            <div className="space-y-1.5">
              {uuids.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <span className="flex-1 truncate font-mono text-xs text-graphite">{u.uuid}</span>
                  <button
                    type="button"
                    disabled={removingUuidId === u.id}
                    onClick={async () => {
                      setRemovingUuidId(u.id)
                      try {
                        await api.partnerUuids.delete(u.id)
                        setUuids((prev) => prev.filter((x) => x.id !== u.id))
                      } catch {
                        // noop
                      } finally {
                        setRemovingUuidId(null)
                      }
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={newUuid}
                onChange={(e) => { setNewUuid(e.target.value); setUuidError(null) }}
                placeholder="Enter UUID"
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-graphite placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-p-blue-light"
              />
              <button
                type="button"
                disabled={!newUuid.trim() || addingUuid}
                onClick={async () => {
                  if (!newUuid.trim() || !partner) return
                  setAddingUuid(true)
                  setUuidError(null)
                  try {
                    const created = await api.partnerUuids.create({ partner_slug: partner.slug, uuid: newUuid.trim() })
                    setUuids((prev) => [...prev, created])
                    setNewUuid('')
                  } catch (err) {
                    setUuidError(err instanceof Error ? err.message : 'Failed to add UUID')
                  } finally {
                    setAddingUuid(false)
                  }
                }}
                className="flex items-center gap-1.5 rounded-lg bg-p-blue-dark px-3 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
              >
                {addingUuid ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </button>
            </div>
            {uuidError && <p className="text-xs text-red-600">{uuidError}</p>}
          </Section>
        )}

        <Section title="Alert configuration">
          <p className="text-xs text-gray-400">
            Default: alert on all errors. Turn off alert types that produce noise for this partner.
            Business rejections never alert regardless.
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">Transient error alerts</p>
                <p className="text-xs text-gray-400">Network failures, timeouts, 429, 502–504</p>
              </div>
              <Toggle checked={alertTransient} onChange={setAlertTransient} label="Transient error alerts" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">Permanent error alerts</p>
                <p className="text-xs text-gray-400">4xx errors, auth failures, bad responses</p>
              </div>
              <Toggle checked={alertPermanent} onChange={setAlertPermanent} label="Permanent error alerts" />
            </div>
          </div>
        </Section>

        <div className="flex items-center gap-3 border-t border-gray-100 pt-6">
          <button
            type="submit"
            disabled={saveState === 'saving' || !name}
            className={`flex min-w-[130px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors duration-150 disabled:opacity-50 ${
              saveState === 'saved' ? 'bg-green-600 hover:bg-green-700' : 'bg-p-blue-dark hover:bg-[#3A8FD0]'
            }`}
          >
            {saveState === 'saving' && <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>}
            {saveState === 'saved'  && <><Check  className="h-4 w-4" /> Saved</>}
            {saveState === 'idle'   && <><Save   className="h-4 w-4" /> {isNew ? 'Create partner' : 'Save changes'}</>}
          </button>
          {undoSnapshot && (
            <button
              type="button"
              onClick={handleUndo}
              className="text-xs text-gray-400 transition-colors hover:text-gray-700"
            >
              Undo · {undoSecondsLeft}s
            </button>
          )}
          {!isNew && !undoSnapshot && (
            <p className="text-xs text-gray-400">
              {`Modified ${new Date(partner.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} by ${partner.updated_by_name ?? partner.updated_by_email?.split('@')[0] ?? '—'}`}
            </p>
          )}
        </div>

      </form>
    </div>
  )
}
