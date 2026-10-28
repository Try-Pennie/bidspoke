'use client'

/**
 * The App Action step's settings (#2338, plan section 3.3 of #1689; settled by
 * Dan in three rounds on 2026-10-24, docs/design/app-action-step-form.html), in
 * the plan's fixed order:
 *  1. what it runs: two dropdowns, Service, then Action listing only that
 *     service's actions (the catalogue, as the card names them);
 *  2. the connection, the step form's own Connection field
 *     (docs/design/connections-step-form.html);
 *  3. the action's arguments, from the pinned version's schema, a dropdown with
 *     a lookup through POST /api/connections/:id/lookup/:key, every other one a
 *     text box.
 * A required field says so in its label, "To (required)", finished or not, and
 * nothing else is added for an unfinished step: the server refuses to switch
 * on a workflow holding one (unfinishedAppActionSteps).
 *
 * An argument that may read earlier steps carries a small Insert button on its
 * label line, which opens the data picker (DataPicker.tsx) under the field: the
 * trigger's test payload and each earlier App Action step's kept test result
 * (GET /api/workflows/:id/test-results/:nodeId), flattened by sampleRows. Its
 * paths also join the field's {{ autocomplete, which they extend.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { ActionArgument } from '@bidspoke/service-catalogue/schema'
import { sampleLabel, sampleRows } from '@bidspoke/references'
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox'
import { Button, Field } from '@/components/ui/form'
import { Select } from '@/components/ui/Select'
import { ConnectionField } from '@/components/connections/ConnectionField'
import { api, type StepTestResult } from '@/lib/api'
import { APP_ACTION_SERVICE_CHOICES, TOO_BIG_TO_KEEP_SENTENCE, appActionChoices, appActionSchema, appActionServiceChoice } from '@/lib/app-action-display'
import TemplateTextarea from './TemplateTextarea'
import { DataPicker, insertReference, type PickerGroup } from './DataPicker'
import { useConnectionListLoader } from './connection-names'

/** An earlier App Action step whose kept test result the picker offers. */
export interface UpstreamStep {
  id: string
  namespace: string
  label?: string
}

type ResultLoad =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: StepTestResult | null }
  | { kind: 'failed'; message: string }

/** An earlier step whose finished test answered nothing, or nothing the picker can offer. */
const NO_VALUES_SENTENCE = 'Its last test answered no values.'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** An argument's name in its label: the catalogue key as a person reads it. */
export const argumentLabel = (arg: ActionArgument) => `${sampleLabel(arg.key)}${arg.required ? ' (required)' : ''}`

export function AppActionConfig({ config, onChange, workflowId, upstream, triggerPayload, refs }: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  workflowId?: string
  upstream: readonly UpstreamStep[]
  triggerPayload: unknown
  refs: string[]
}) {
  const base = useId()
  const loadConnections = useConnectionListLoader()
  const choice = appActionServiceChoice(config)
  const actions = useMemo(() => appActionChoices(choice), [choice])
  const schema = appActionSchema(config)
  const args = isRecord(config.args) ? config.args : {}
  const connection = typeof config.connection === 'string' && config.connection !== '' ? config.connection : null

  function chooseService(value: string) {
    const next = APP_ACTION_SERVICE_CHOICES.find((c) => c.value === value)
    if (!next) return
    const sameService = next.service === config.service
    onChange({ service: next.service, action: undefined, actionVersion: undefined, args: {}, ...(sameService ? {} : { connection: undefined }) })
  }

  function chooseAction(value: string) {
    const next = actions.find((a) => a.value === value)
    if (!next) return
    onChange({ action: next.value, actionVersion: next.version })
  }

  const setArg = useCallback((key: string, value: string) => {
    const nextArgs = { ...args }
    if (value === '') delete nextArgs[key]
    else nextArgs[key] = value
    onChange({ args: nextArgs })
  }, [args, onChange])

  // ── The picker's sources: the trigger's test payload, then each earlier step's kept test result.
  const [results, setResults] = useState<Record<string, ResultLoad>>({})
  const readResult = useCallback((step: UpstreamStep) => {
    // A workflow not yet saved keeps no tests, so it has none to read: say so
    // rather than leave the step reading for ever (lessons review, L10).
    if (!workflowId) {
      setResults((r) => ({ ...r, [step.id]: { kind: 'ready', result: null } }))
      return
    }
    setResults((r) => ({ ...r, [step.id]: { kind: 'loading' } }))
    api.workflows.testResult(workflowId, step.id).then(
      (answer) => setResults((r) => ({ ...r, [step.id]: { kind: 'ready', result: answer.result } })),
      () => setResults((r) => ({ ...r, [step.id]: { kind: 'failed', message: `${step.label || step.namespace}'s last test could not be read.` } })),
    )
  }, [workflowId])
  const openPicker = useCallback(() => {
    for (const step of upstream) if ((results[step.id]?.kind ?? 'idle') === 'idle') readResult(step)
  }, [upstream, results, readResult])

  const groups = useMemo<PickerGroup[]>(() => {
    const trigger = sampleRows('trigger.payload', triggerPayload ?? {}).rows
    const out: PickerGroup[] = [{
      key: 'trigger',
      from: 'Trigger',
      state: trigger.length > 0 ? { kind: 'rows', rows: trigger } : { kind: 'empty', sentence: 'The trigger has no test payload yet.' },
    }]
    for (const step of upstream) {
      const name = step.label || step.namespace
      const load = results[step.id] ?? { kind: 'idle' }
      if (load.kind === 'idle' || load.kind === 'loading') out.push({ key: step.id, from: name, state: { kind: 'loading' } })
      else if (load.kind === 'failed') out.push({ key: step.id, from: name, state: { kind: 'failed', message: load.message, retry: () => readResult(step) } })
      else if (load.result === null) out.push({ key: step.id, from: name, state: { kind: 'empty', sentence: 'No test in the last 7 days. Test the step to pick its values.' } })
      else if (load.result.status !== 'completed') out.push({ key: step.id, from: name, state: { kind: 'empty', sentence: 'Its last test did not finish, so it has no values.' } })
      // A finished test kept no answer for one of two reasons (#2882): it was too big to keep, or the action answered nothing.
      else if (load.result.output_dropped) out.push({ key: step.id, from: name, state: { kind: 'empty', sentence: TOO_BIG_TO_KEEP_SENTENCE } })
      else if (load.result.output === null) out.push({ key: step.id, from: name, state: { kind: 'empty', sentence: NO_VALUES_SENTENCE } })
      else {
        const rows = sampleRows(`steps.${step.namespace}.output`, load.result.output).rows
        out.push({ key: step.id, from: name, state: rows.length > 0 ? { kind: 'rows', rows } : { kind: 'empty', sentence: NO_VALUES_SENTENCE } })
      }
    }
    return out
  }, [triggerPayload, upstream, results, readResult])

  // The picker's paths extend the {{ autocomplete, never replace it.
  const fieldRefs = useMemo(() => {
    const extra = groups.flatMap((g) => (g.state.kind === 'rows' ? g.state.rows.map((r) => r.path) : []))
    return [...refs, ...extra.filter((p) => !refs.includes(p))]
  }, [refs, groups])

  return (
    <>
      <Field id={`${base}-service`} label="Service (required)">
        <Select
          id={`${base}-service`}
          value={choice?.value ?? ''}
          onChange={chooseService}
          options={APP_ACTION_SERVICE_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          placeholder="Choose a service"
        />
      </Field>
      <Field id={`${base}-action`} label="Action (required)">
        <Select
          id={`${base}-action`}
          value={typeof config.action === 'string' ? config.action : ''}
          onChange={chooseAction}
          options={actions.map((a) => ({ value: a.value, label: a.label }))}
          placeholder={choice ? 'Choose an action' : 'Choose a service first'}
          disabled={choice === null}
        />
      </Field>
      {choice && (
        <ConnectionField
          id={`${base}-connection`}
          service={choice.service}
          value={connection}
          onChange={(id) => onChange({ connection: id })}
          loadList={loadConnections}
          label="Connection (required)"
        />
      )}
      {schema?.arguments.map((arg) => (
        <ArgumentField
          key={arg.key}
          id={`${base}-arg-${arg.key}`}
          arg={arg}
          value={typeof args[arg.key] === 'string' ? (args[arg.key] as string) : args[arg.key] === undefined ? '' : JSON.stringify(args[arg.key])}
          onChange={(v) => setArg(arg.key, v)}
          refs={fieldRefs}
          groups={groups}
          onOpenPicker={openPicker}
          connection={connection}
          parents={(arg.dependsOn ?? []).map((k) => (typeof args[k] === 'string' ? (args[k] as string) : ''))}
        />
      ))}
    </>
  )
}

function ArgumentField({ id, arg, value, onChange, refs, groups, onOpenPicker, connection, parents }: {
  id: string
  arg: ActionArgument
  value: string
  onChange: (value: string) => void
  refs: string[]
  groups: readonly PickerGroup[]
  onOpenPicker: () => void
  connection: string | null
  parents: string[]
}) {
  const [open, setOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const pickerId = `${id}-picker`
  const label = argumentLabel(arg)

  if (arg.type === 'dropdown' && arg.source) {
    return (
      <Field id={id} label={label}>
        <LookupDropdown id={id} lookup={arg.source.lookup} connection={connection} parents={parents} value={value} onChange={onChange} />
      </Field>
    )
  }

  const multiline = arg.multiline === true || arg.type === 'code'
  const control = (
    <TemplateTextarea
      id={id}
      value={value}
      onChange={onChange}
      refs={arg.allowsVariables ? refs : []}
      input={!multiline}
      hideHint
      className={multiline ? `textarea${arg.type === 'code' ? ' font-mono' : ''}` : 'input'}
    />
  )
  if (!arg.allowsVariables) {
    return <Field id={id} label={label}>{control}</Field>
  }

  function pick(path: string) {
    const box = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null
    const next = insertReference(value, path, box?.selectionStart ?? null, box?.selectionEnd ?? null)
    onChange(next.value)
    setOpen(false)
    requestAnimationFrame(() => {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null
      el?.focus()
      el?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  return (
    <div ref={fieldRef} className="field relative">
      <div className="mb-1 flex items-center justify-between">
        <label id={`${id}-label`} htmlFor={id} className="block text-xs font-medium text-gray-600">{label}</label>
        <Button
          variant="secondary"
          className="btn-sm"
          part="insert"
          aria-label={`Insert a value into ${sampleLabel(arg.key)}`}
          popup={{ expanded: open, controls: open ? pickerId : undefined }}
          onClick={() => { if (!open) onOpenPicker(); setOpen((o) => !o) }}
        >
          Insert
        </Button>
      </div>
      {control}
      {open && (
        <DataPicker
          id={pickerId}
          groups={groups}
          onPick={pick}
          onClose={(returnFocus) => {
            setOpen(false)
            if (returnFocus) fieldRef.current?.querySelector<HTMLButtonElement>('button[data-part="insert"]')?.focus()
          }}
        />
      )}
    </div>
  )
}

/** A dropdown filled by a lookup on the step's connection; a failed lookup shows its error in the list (L10). */
export function LookupDropdown({ id, lookup, connection, parents, value, onChange }: {
  id: string
  lookup: string
  connection: string | null
  parents: string[]
  value: string
  onChange: (value: string) => void
}) {
  const parentsKey = parents.join('\u0000')
  const load = useCallback(async (): Promise<ComboboxOption[]> => {
    if (connection === null) throw new Error('Choose a connection first, then its list can be read.')
    let answer
    try {
      answer = (await api.connections.lookup(connection, lookup, parentsKey === '' ? [] : parentsKey.split('\u0000'))).answer
    } catch (err) {
      const message = err instanceof Error && err.message.trim() ? err.message : 'The list could not be read from the connection.'
      throw new Error(message)
    }
    if ('entries' in answer) return answer.entries.map((e) => ({ value: e.name, label: e.label || e.name }))
    return answer.fields.map((f) => ({ value: f.name, label: f.label || f.name, hint: f.type }))
  }, [connection, lookup, parentsKey])
  return (
    <Combobox
      key={`${connection ?? ''}|${parentsKey}`}
      id={id}
      value={value}
      onChange={onChange}
      loadOptions={load}
      placeholder={connection === null ? 'Choose a connection first' : 'Choose one'}
      disabled={connection === null}
    />
  )
}
