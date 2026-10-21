'use client'

import { useState } from 'react'
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox'
import { Field } from '@/components/ui/form'
import FieldAutocomplete from '@/components/rule-builder/FieldAutocomplete'
import TemplateTextarea from '@/components/canvas/TemplateTextarea'

const ORGS: ComboboxOption[] = [
  { value: 'achieve', label: 'Achieve', hint: 'achieve.my.salesforce.com' },
  { value: 'pennie', label: 'Pennie', hint: 'trypennie.my.salesforce.com' },
  { value: 'pathway', label: 'Pathway Financial Services Partners of America', hint: 'pathwayfinancialservicespartnersofamerica.my.salesforce.com' },
  { value: 'lendco-sandbox', label: 'Lendco sandbox', hint: 'lendco--uat.sandbox.my.salesforce.com' },
]

/** Sixty items, the size a Drive folder or mailbox lookup can reach. */
const MANY: ComboboxOption[] = Array.from({ length: 60 }, (_, i) => ({
  value: `folder-${i + 1}`,
  label: `Lead exports ${String(i + 1).padStart(2, '0')}`,
  hint: `Shared drive, folder ${i + 1}`,
}))

const NEW_ORG = {
  chooseLabel: 'Another org',
  useLabel: (typed: string) => `Use ${typed} as a new org`,
  placeholder: 'name.my.salesforce.com',
}

const loaders = {
  orgs: async () => ORGS,
  many: async () => MANY,
  failed: async (): Promise<ComboboxOption[]> => { throw new Error('Salesforce did not answer, so the orgs could not be read.') },
  empty: async () => [],
  hanging: () => new Promise<ComboboxOption[]>(() => {}),
}

function Frame({ name, label, initial = '', load, newValue, emptyMessage, placeholder = 'Choose an org' }: {
  name: string
  label: string
  initial?: string
  load: (signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  newValue?: typeof NEW_ORG
  emptyMessage?: string
  placeholder?: string
}) {
  const [value, setValue] = useState(initial)
  const id = `combobox-${name}`
  return (
    <section data-frame={name} className="h-[26rem] rounded-xl border border-line bg-white p-4">
      <Field id={id} label={label}>
        <Combobox id={id} value={value} onChange={(v) => setValue(v)} loadOptions={load} placeholder={placeholder} newValue={newValue} emptyMessage={emptyMessage} />
      </Field>
    </section>
  )
}

const REFS = ['steps.credit.output.score', 'steps.credit.output.tradelines', 'steps.enrich.output.state', 'trigger.payload.email', 'env.ACHIEVE_UTM_SOURCE']

/** The rule builder's field list and the canvas reference list, the two other dropdowns (round 27). */
function ListFrame({ name }: { name: 'rules' | 'canvas' }) {
  const [value, setValue] = useState('')
  return (
    <section data-frame={name} className="h-[26rem] rounded-xl border border-line bg-white p-4">
      <p className="mb-1 text-xs font-medium text-gray-600">{name === 'rules' ? 'Rule builder field' : 'Canvas template'}</p>
      {name === 'rules'
        ? <FieldAutocomplete value={value} onChange={setValue} suggestions={REFS} className="input font-mono" />
        : <TemplateTextarea value={value} onChange={setValue} refs={REFS} className="textarea font-mono" />}
    </section>
  )
}

export function ComboboxPreview() {
  return (
    <main className="min-h-screen bg-beige px-4 py-6 text-graphite sm:px-8">
      <h1 className="mb-4 text-lg font-semibold">Dropdown preview</h1>
      <div className="grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Frame name="chosen" label="Org" initial="achieve" load={loaders.orgs} newValue={NEW_ORG} />
        <Frame name="open" label="Org" initial="pennie" load={loaders.orgs} newValue={NEW_ORG} />
        <Frame name="new" label="Org" load={loaders.orgs} newValue={NEW_ORG} />
        <Frame name="failed" label="Org" load={loaders.failed} newValue={NEW_ORG} />
        <Frame name="empty" label="Org" load={loaders.empty} emptyMessage="Bidspoke knows no Salesforce orgs yet." />
        <Frame name="slow" label="Org" load={loaders.hanging} />
        <Frame name="stalled" label="Org" load={loaders.hanging} />
        <Frame name="many" label="Folder" load={loaders.many} placeholder="Choose a folder" />
        <ListFrame name="rules" />
        <ListFrame name="canvas" />
      </div>
    </main>
  )
}
