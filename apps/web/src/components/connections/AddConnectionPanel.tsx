'use client'

/**
 * The Add connection form (#2338, build PR 10; R11 to R16, D11 to D17), in the
 * right panel in place of the details, drawn to
 * docs/design/connections-page.html: the service's tiles from the catalogue,
 * then that service's fields, in its declaration's order after Name, Save and
 * Cancel, and the line under them that says the login is being checked,
 * counting, or why the save failed.
 *
 * Its state is connectionsReducer's (AddState); this file lays it out and
 * sends events. Enter in a field never saves: no field sits in a form, and the
 * boxes hold Enter themselves. While a save checks its login only Save is held
 * (D13): the fields and Cancel stay ready, since nothing typed now changes
 * what was sent, and a save that lands after Cancel is still listed. The data-part attributes are what the settled
 * design's checks read, never a styling hook.
 */
import { useCallback, useId, useMemo } from 'react'
import type { ConnectionField } from '@bidspoke/service-catalogue/schema'
import { Button, ChoiceGroup, FieldError, Outcome, SecretBlock, SecretInput, TextInput } from '@/components/ui/form'
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox'
import { Select } from '@/components/ui/Select'
import { draftValues, workingLabel, type FormService, type GoogleWay, type OrgOption } from './add-form-model'
import { delegationShown } from './connection-model'
import type { AddState, ConnectionsState, SaveState } from './connections-state'

export interface AddPanelProps {
  add: AddState
  now: number
  services: readonly FormService[]
  orgs: readonly OrgOption[]
  google: ConnectionsState['google']
  onService: (key: string | null) => void
  onName: (text: string) => void
  onField: (field: string, text: string, typedNew?: boolean) => void
  onGoogle: (way: GoogleWay) => void
  onSave: () => void
  onCancel: () => void
  onGoogleRetry: () => void
}

/** The words a Google connection's two cards say (R16, D16). */
const GOOGLE_WAYS: ReadonlyArray<{ value: GoogleWay; label: string; hint: string }> = [
  { value: 'company', label: 'A company mailbox or drive', hint: 'From the company list' },
  { value: 'own', label: 'My own Google account', hint: 'Signed in as you' },
]

/** A labelled field as the design draws it: the label over the control, named for the checks by its label. */
function FormRow({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="ad-field" data-part="field" data-field={label}>
      <label id={`${id}-label`} htmlFor={id} className="ad-label">{label}</label>
      {children}
    </div>
  )
}

/** The line under the buttons: the check running, counting (R13), or why it failed (R14). */
export function SaveLine({ save, now, label }: { save: SaveState; now: number; label: string }) {
  if (save.kind === 'saving') {
    return (
      <div className="ad-line" data-part="save-line" data-state="saving">
        <Outcome state={{ kind: 'working', label, startedAt: save.startedAt, now }} />
      </div>
    )
  }
  if (save.kind === 'failed') return <FieldError alert size="sm" part="save-line" partState="failed" className="ad-line">{save.sentence}</FieldError>
  return null
}

/** Google's own Sign in with Google button, with its logo (R17, D17). It starts the sign in from build PR 13; until then it does nothing. */
function GoogleSignIn() {
  return (
    <Button variant="secondary" className="g-btn" part="google-sign-in">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z" />
        <path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.8-6z" />
        <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
      </svg>
      Sign in with Google
    </Button>
  )
}

export function AddConnectionPanel(props: AddPanelProps) {
  const { add, now, services, orgs, google, onService, onName, onField, onGoogle, onSave, onCancel, onGoogleRetry } = props
  const base = useId()
  const draft = add.draft
  const service = services.find((s) => s.key === draft.service) ?? null
  const values = draftValues(draft)
  const saving = add.save.kind === 'saving'
  const delegation = service?.connection.auth === 'service_account_delegation'
  const own = delegation && draft.google === 'own'
  const orgOptions = useMemo<ComboboxOption[]>(() => orgs.map((o) => ({ value: o.value, label: o.label, hint: o.hint })), [orgs])
  const loadOrgs = useCallback(() => Promise.resolve(orgOptions), [orgOptions])
  const idOf = (key: string) => `${base}-${key}`

  const fieldControl = (f: ConnectionField) => {
    const id = idOf(f.key)
    const value = values[f.key] ?? ''
    switch (f.input) {
      case 'secret':
        return <SecretInput id={id} value={value} onChange={(t) => onField(f.key, t)} />
      case 'secret_block':
        return <SecretBlock id={id} value={value} onChange={(t) => onField(f.key, t)} />
      case 'salesforce_org':
        return (
          <Combobox
            // A new list of known orgs is a new load.
            key={orgOptions.map((o) => o.value).join(' ')}
            id={id}
            value={value}
            valueIsNew={draft.typedNew[service!.key]?.[f.key] === true}
            onChange={(v, choice) => onField(f.key, v, choice.isNew)}
            loadOptions={loadOrgs}
            placeholder="Choose an org"
            emptyMessage="Bidspoke knows no org yet."
            newValue={{ chooseLabel: 'Another org', useLabel: (t) => `Use ${t} as a new org`, placeholder: "The org's address" }}
          />
        )
      case 'google_subject':
        return null
      default:
        return <TextInput id={id} value={value} onChange={(t) => onField(f.key, t)} />
    }
  }

  return (
    <section className="cx-card cx-detail" data-part="add-form" aria-label="Add a connection">
      <h2>Add a connection</h2>
      <div className="ad-form">
        <div>
          <span id={`${base}-service`} className="ad-label">Service</span>
          {service
            ? (
              // Round 12: once chosen, the tile stands alone above its fields; pressing it chooses again.
              <div role="group" aria-labelledby={`${base}-service`}>
                <div className="sv-tile-wrap" data-part="service-tile" data-service={service.name} data-chosen="true">
                  <Button variant="row" className="sv-tile sv-on" current onClick={() => onService(null)}>
                    <span className="sv-tile-name">{service.name}</span>
                    <span className="cx-hint">{service.tile}</span>
                  </Button>
                </div>
              </div>
            )
            : (
              <div className="sv-grid" role="group" aria-labelledby={`${base}-service`}>
                {services.map((s) => (
                  <div key={s.key} className="sv-tile-wrap" data-part="service-tile" data-service={s.name}>
                    <Button variant="row" className="sv-tile" onClick={() => onService(s.key)}>
                      <span className="sv-tile-name">{s.name}</span>
                      <span className="cx-hint">{s.tile}</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
        </div>

        {service && (
          <>
            <FormRow id={idOf('name')} label="Name">
              <TextInput id={idOf('name')} value={draft.name} onChange={onName} />
            </FormRow>
            {service.connection.fields.map((f) => (f.input === 'google_subject'
              ? (
                <div key={f.key}>
                  {/* The group is named by its own label; this is the same words on screen. */}
                  <span className="ad-label" aria-hidden="true">{f.label}</span>
                  <ChoiceGroup id={idOf(`${f.key}-way`)} label={f.label} visibleLabel="" value={draft.google} layout="cards" optionPart="choice-card" options={GOOGLE_WAYS} onChange={onGoogle} />
                  {!own && (
                    <div className="gk-pick">
                      {google?.kind === 'loaded'
                        ? google.subjects.length > 0
                          ? (
                            <Select
                              id={idOf(f.key)}
                              value={values[f.key] ?? ''}
                              onChange={(v) => onField(f.key, v)}
                              aria-label="The mailbox or drive it acts as"
                              placeholder="Choose a mailbox or drive"
                              options={google.subjects.map((e) => ({ value: e.subject, label: delegationShown(e) }))}
                            />
                          )
                          : <p className="cx-empty">Nothing is on the company list yet. Add a mailbox or drive to it under Google first.</p>
                        : google?.kind === 'failed'
                          ? (
                            <div className="ga-failed">
                              <FieldError alert size="sm">{google.sentence}</FieldError>
                              <Button variant="secondary" className="cx-btn-quiet" onClick={onGoogleRetry}>Try again</Button>
                            </div>
                          )
                          : <Outcome state={{ kind: 'working', label: 'Loading the company list', startedAt: google?.startedAt ?? now, now }} />}
                    </div>
                  )}
                </div>
              )
              : <FormRow key={f.key} id={idOf(f.key)} label={f.label}>{fieldControl(f)}</FormRow>))}
          </>
        )}

        <div className="ad-foot">
          {service && (own
            ? <GoogleSignIn />
            : <Button variant="primary" className="cx-btn cx-btn-sm" onClick={onSave} disabled={saving}>Save</Button>)}
          <Button variant="secondary" className="cx-btn-quiet" onClick={onCancel}>Cancel</Button>
        </div>
        {service && <SaveLine save={add.save} now={now} label={workingLabel(service.name)} />}
      </div>
    </section>
  )
}
