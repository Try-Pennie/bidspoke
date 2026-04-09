'use client'

import { useState } from 'react'
import type { Partner, PartnerBody } from '@/lib/api'
import { Save, Trash2, Loader2, ToggleLeft, ToggleRight } from 'lucide-react'

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
      className={`w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-200 ${mono ? 'font-mono' : ''}`}
    />
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Basic fields
  const [name, setName] = useState(partner?.name ?? '')
  const [slug, setSlug] = useState(partner?.slug ?? '')
  const [apiEndpoint, setApiEndpoint] = useState(partner?.api_endpoint ?? '')
  const [cfSecretKey, setCfSecretKey] = useState(partner?.cf_secret_key ?? '')
  const [isActive, setIsActive] = useState(partner?.is_active ?? true)
  const [priority, setPriority] = useState(String(partner?.priority ?? 0))

  // Bidding
  const [dailyCap, setDailyCap] = useState(partner?.daily_cap != null ? String(partner.daily_cap) : '')
  const [minBid, setMinBid] = useState(partner?.min_bid != null ? String(partner.min_bid) : '')
  const [bidFormula, setBidFormula] = useState(partner?.bid_formula ?? '')
  const [dedupEndpoint, setDedupEndpoint] = useState(partner?.dedup_endpoint ?? '')

  // Circuit breaker
  const [circuitEnabled, setCircuitEnabled] = useState(partner?.circuit_enabled ?? true)
  const [circuitThreshold, setCircuitThreshold] = useState(String(partner?.circuit_error_threshold ?? 5))
  const [circuitWindow, setCircuitWindow] = useState(String(partner?.circuit_window_seconds ?? 60))
  const [circuitCooldown, setCircuitCooldown] = useState(String(partner?.circuit_cooldown_seconds ?? 300))

  // Response classification
  const [responseClassification, setResponseClassification] = useState(
    partner?.response_classification
      ? JSON.stringify(partner.response_classification, null, 2)
      : ''
  )
  const [responseClassificationError, setResponseClassificationError] = useState<string | null>(null)

  // Alert config
  const defaultAlertConfig = partner?.alert_config as { transient_errors?: { alert?: boolean }; permanent_errors?: { alert?: boolean } } | null | undefined
  const [alertTransient, setAlertTransient] = useState(defaultAlertConfig?.transient_errors?.alert !== false)
  const [alertPermanent, setAlertPermanent] = useState(defaultAlertConfig?.permanent_errors?.alert !== false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setResponseClassificationError(null)
    setSaving(true)

    // Parse response_classification JSON if provided
    let parsedClassification: unknown = null
    if (responseClassification.trim()) {
      try {
        parsedClassification = JSON.parse(responseClassification)
      } catch {
        setResponseClassificationError('Invalid JSON — check syntax and try again.')
        setSaving(false)
        return
      }
    }

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
        response_classification: parsedClassification,
        alert_config: {
          transient_errors: { alert: alertTransient },
          permanent_errors: { alert: alertPermanent },
        },
      }
      await onSave(body, partner?.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save partner')
    } finally {
      setSaving(false)
    }
  }

  const isNew = !partner

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            {isNew ? 'New partner' : partner.name}
          </h2>
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
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
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
            <Input value={name} onChange={setName} placeholder="Tripoint" />
          </Field>
          {isNew ? (
            <Field
              label="Slug"
              hint="Lowercase identifier used in logs and workflow references. Cannot be changed after creation."
            >
              <Input value={slug} onChange={setSlug} placeholder="tripoint" mono />
            </Field>
          ) : null}
          <div className="flex items-center gap-6">
            <Field label="Priority">
              <Input value={priority} onChange={setPriority} type="number" placeholder="0" />
            </Field>
            <Field label="Status">
              <button
                type="button"
                onClick={() => setIsActive((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {isActive
                  ? <><ToggleRight className="h-4 w-4 text-green-500" /> Active</>
                  : <><ToggleLeft className="h-4 w-4 text-gray-400" /> Inactive</>
                }
              </button>
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
            hint="Name of the secret (stored in Cloudflare Workers) that holds this partner's API key. Enter the secret name, not the value itself — e.g. TRIPOINT_API_KEY."
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
            hint="Expression evaluated to compute the bid price. Variables from trigger.payload and steps.* are available. E.g. debt_amount * 0.65"
          >
            <textarea
              value={bidFormula}
              onChange={(e) => setBidFormula(e.target.value)}
              placeholder="debt_amount * 0.65"
              rows={2}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-900 placeholder-gray-400 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
          </Field>
        </Section>

        <Section title="Circuit breaker">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setCircuitEnabled((v) => !v)}
              className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {circuitEnabled
                ? <><ToggleRight className="h-4 w-4 text-green-500" /> Enabled</>
                : <><ToggleLeft className="h-4 w-4 text-gray-400" /> Disabled</>
              }
            </button>
            <p className="text-xs text-gray-400">
              Pauses bids to this partner after repeated failures, then retries automatically.
            </p>
          </div>

          {circuitEnabled && (
            <div className="grid grid-cols-3 gap-4">
              <Field
                label="Error threshold"
                hint="How many errors in the window before pausing."
              >
                <Input value={circuitThreshold} onChange={setCircuitThreshold} type="number" placeholder="5" />
              </Field>
              <Field
                label="Window (seconds)"
                hint="Time period to count errors in."
              >
                <Input value={circuitWindow} onChange={setCircuitWindow} type="number" placeholder="60" />
              </Field>
              <Field
                label="Pause duration (seconds)"
                hint="How long to wait before trying again."
              >
                <Input value={circuitCooldown} onChange={setCircuitCooldown} type="number" placeholder="300" />
              </Field>
            </div>
          )}
        </Section>

        <Section title="Response classification">
          <p className="text-xs text-gray-400">
            Override how this partner&apos;s responses are classified. Evaluated before default rules.
            Leave blank to use defaults (HTTP status–based classification).
          </p>
          <Field
            label="Signal overrides (JSON)"
            hint={'Supported keys: rejection_signals, transient_signals, permanent_signals. Each signal is { field, equals?, contains?, present? } for body fields or { status_code?, body_field?, contains?, header?, present? } for status signals.'}
          >
            <textarea
              value={responseClassification}
              onChange={(e) => {
                setResponseClassification(e.target.value)
                setResponseClassificationError(null)
              }}
              rows={8}
              placeholder={`{
  "rejection_signals": [
    { "field": "status", "equals": "rejected" },
    { "field": "accepted", "equals": false }
  ],
  "transient_signals": [
    { "status_code": 200, "body_field": "error", "contains": "service unavailable" },
    { "status_code": 403, "header": "Retry-After", "present": true }
  ],
  "permanent_signals": [
    { "status_code": 503, "body_field": "error", "contains": "account suspended" }
  ]
}`}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs text-gray-900 placeholder-gray-300 focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
            {responseClassificationError && (
              <p className="mt-1 text-xs text-red-600">{responseClassificationError}</p>
            )}
          </Field>
        </Section>

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
              <button
                type="button"
                onClick={() => setAlertTransient((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {alertTransient
                  ? <><ToggleRight className="h-4 w-4 text-green-500" /> On</>
                  : <><ToggleLeft className="h-4 w-4 text-gray-400" /> Off</>
                }
              </button>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">Permanent error alerts</p>
                <p className="text-xs text-gray-400">4xx errors, auth failures, bad responses</p>
              </div>
              <button
                type="button"
                onClick={() => setAlertPermanent((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {alertPermanent
                  ? <><ToggleRight className="h-4 w-4 text-green-500" /> On</>
                  : <><ToggleLeft className="h-4 w-4 text-gray-400" /> Off</>
                }
              </button>
            </div>
          </div>
        </Section>

        <div className="flex items-center gap-3 border-t border-gray-100 pt-6">
          <button
            type="submit"
            disabled={saving || !name}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              : <><Save className="h-4 w-4" /> {isNew ? 'Create partner' : 'Save changes'}</>
            }
          </button>
          {!isNew && (
            <p className="text-xs text-gray-400">
              Last updated {partner.updated_by_email ? `by ${partner.updated_by_email}` : ''}
            </p>
          )}
        </div>

      </form>
    </div>
  )
}
