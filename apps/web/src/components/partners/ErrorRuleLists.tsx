'use client'

/**
 * The Retry and Never retry lists of a partner's response classification
 * (#2143, PM-11, the settled design's Errors rows).
 *
 * Each list is the person's own rules, then the defaults the engine classifies
 * a failed call by when none of them matched, as fixed rows marked Default,
 * then Add rule. The defaults come from DEFAULT_ERROR_RULES through
 * defaultErrorRowsFor, the constant the engine's classifier reads, so the page
 * cannot describe a default the engine does not apply (L41, L107). The calls a
 * partner's page governs are its bid API and, for a buyer, buyer selection and
 * click sends (PARTNER_PAGE_ERROR_SCOPES); no default applies to the buyer
 * calls, which the sale outcome rules judge, so the rows are the bid API's. A
 * default that applies only to Code node scripts is never listed, and one that
 * applies but cannot be a row is named under its list with why.
 *
 * Each list carries its own Alert switch (the design's "an Alert switch on each
 * Errors list"): the partner's alert_config.transient_errors.alert for Retry,
 * alert_config.permanent_errors.alert for Never retry.
 */
import { defaultErrorRowsFor, PARTNER_PAGE_ERROR_SCOPES, type ErrorDecision } from '@bidspoke/buyer-profile'
import type { SignalRules } from '@/app/(app)/partners/partner-draft'
import { Toggle } from '@/components/ui/Toggle'
import { SignalRuleBuilder, type SignalSection } from './SignalRuleBuilder'

const DEFAULT_ROWS = defaultErrorRowsFor(PARTNER_PAGE_ERROR_SCOPES)

/** The two lists, named by what a match does, as the settled design names them. */
const LISTS: ReadonlyArray<SignalSection & { decision: ErrorDecision }> = [
  { cat: 'transient', decision: 'transient', label: 'Retry when any of', desc: '' },
  { cat: 'permanent', decision: 'permanent', label: 'Never retry when any of', desc: '' },
]

function Defaults({ decision }: { decision: ErrorDecision }) {
  const shown = DEFAULT_ROWS.shown.filter((r) => r.decision === decision)
  const notShown = DEFAULT_ROWS.notShown.filter((r) => r.decision === decision)
  return (
    <>
      {shown.map((rule) => (
        <div key={rule.id} data-testid="default-error-row" className="flex items-center justify-between gap-3 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-700">
          <span>{rule.label}</span>
          <span className="shrink-0 text-gray-600">Default</span>
        </div>
      ))}
      {notShown.map((rule) => (
        <p key={rule.id} className="text-xs text-gray-600">Not shown as a row: {rule.label}. {rule.notShownBecause}</p>
      ))}
    </>
  )
}

function AlertSwitch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-gray-700">
      <Toggle id={id} checked={checked} onChange={onChange} label={label} />
      <span aria-hidden="true">Alert</span>
    </span>
  )
}

export function ErrorRuleLists({ value, onChange, alertRetried, onAlertRetried, alertNotRetried, onAlertNotRetried }: {
  value: SignalRules
  onChange: (next: SignalRules) => void
  /** alert_config.transient_errors.alert */
  alertRetried: boolean
  onAlertRetried: (v: boolean) => void
  /** alert_config.permanent_errors.alert */
  alertNotRetried: boolean
  onAlertNotRetried: (v: boolean) => void
}) {
  return (
    <div className="space-y-3">
      <SignalRuleBuilder
        value={value}
        onChange={onChange}
        sections={LISTS}
        extras={{
          transient: {
            aside: <AlertSwitch id="partner-alert-transient" checked={alertRetried} onChange={onAlertRetried} label="Alert on errors that are retried" />,
            after: <Defaults decision="transient" />,
          },
          permanent: {
            aside: <AlertSwitch id="partner-alert-permanent" checked={alertNotRetried} onChange={onAlertNotRetried} label="Alert on errors that are not retried" />,
            after: <Defaults decision="permanent" />,
          },
        }}
      />
      <p className="text-xs text-gray-600">Your rules are checked before the defaults. A decline is never an alert.</p>
    </div>
  )
}
