'use client'

/**
 * A workflow step's Connection field (#2338 build PR 11, R8, D8), as settled in
 * design rounds 8, 8b and 24 (docs/design/connections-step-form.html): the
 * app's dropdown showing the chosen connection's name, with "Acts as <who>"
 * under it and nothing about status while the connection works. A connection
 * with a problem adds one red line, its status in the Connections page's own
 * words and where it is fixed, "Needs reconnecting on the Connections page",
 * the page's name a dark underlined link that opens the connection there. A
 * failing check reads "Check failing on the Connections page" (Dan,
 * 2026-10-20).
 *
 * The step stores only the connection's id, as every definition writer
 * requires; the field shows the name. The list is `GET /api/connections`, which
 * can wait up to 15 s for the login checks, so while it loads the field says so
 * with the seconds counted, and at the call's own ceiling the wait becomes the
 * error with Try again. The menu and the lines under the field read the one
 * load (useListLoad), so they never disagree and Try again retries it once.
 *
 * Mounted on a step in #2339. Who can call what it reads: any signed in user
 * of the organization, for the organization's own connections only (the list
 * route's jwtAuth).
 */
import { useCallback, useMemo } from 'react'
import Link from 'next/link'
import { CATALOGUE } from '@bidspoke/service-catalogue/schema'
import { api, CONNECTIONS_LIST_TIMEOUT_MS, type ConnectionList } from '@/lib/api'
import { ComboboxControl, realClock, useListLoad, type ComboboxClock, type ComboboxOption, type ListLoadHandle } from '@/components/ui/Combobox'
import { Button, Field, FieldError, Outcome } from '@/components/ui/form'
import { LIST_NO_ANSWER, listFailureCause, loadFailedSentence, viewOf, type ConnectionView } from './connection-model'
import { connectionFieldLines, connectionOptions, connectionsFor, type FieldLine, type FieldList } from './connection-field-model'

export interface ConnectionFieldProps {
  id: string
  /** The step's service, its catalogue key ('salesforce'). */
  service: string
  /** The chosen connection's id, or null when none is chosen. */
  value: string | null
  onChange: (id: string) => void
  /** The connections list; the live route unless a caller (a test, the preview) gives its own. */
  loadList?: () => Promise<ConnectionList>
  clock?: ComboboxClock
  disabled?: boolean
}

const liveList = () => api.connections.list()

export function ConnectionField({ id, service, value, onChange, loadList = liveList, clock = realClock, disabled }: ConnectionFieldProps) {
  const serviceName = CATALOGUE.find((s) => s.key === service)?.name ?? service
  const loader = useCallback(async (): Promise<ConnectionView[]> => {
    let answer: ConnectionList
    try {
      answer = await loadList()
    } catch (err) {
      // The menu shows a loader's error verbatim, so it is the page's plain sentence, never a raw fetch error.
      throw new Error(loadFailedSentence(listFailureCause(err)))
    }
    return connectionsFor(service, answer.connections.map(viewOf))
  }, [loadList, service])
  const list = useListLoad<ConnectionView>(loader, { clock, deadlineMs: CONNECTIONS_LIST_TIMEOUT_MS, stalledMessage: loadFailedSentence(LIST_NO_ANSWER) })

  const options = useMemo<ListLoadHandle<ComboboxOption>>(() => ({
    now: list.now,
    retry: list.retry,
    load: list.load.kind === 'ready' ? { kind: 'ready', options: connectionOptions(list.load.options) } : list.load,
  }), [list])
  const read: FieldList = list.load.kind === 'loading'
    ? { kind: 'loading', seconds: Math.max(0, Math.floor((list.now - list.load.startedAt) / 1000)) }
    : list.load.kind === 'failed' ? { kind: 'failed', message: list.load.message } : { kind: 'ready', connections: list.load.options }
  const lines = connectionFieldLines(read, value, serviceName)
  const statusId = `${id}-status`

  return (
    <div data-part="connection-field">
      <Field id={id} label="Connection">
        <ComboboxControl
          id={id}
          value={value ?? ''}
          onChange={(next) => onChange(next)}
          list={options}
          placeholder="Choose a connection"
          emptyMessage={`No ${serviceName} connection yet.`}
          hideUnlistedValue
          disabled={disabled}
          describedBy={lines.length ? statusId : undefined}
          clock={clock}
        />
        {lines.map((line) => <Line key={line.kind} id={statusId} line={line} onRetry={list.retry} />)}
      </Field>
    </div>
  )
}

function Line({ id, line, onRetry }: { id: string; line: FieldLine; onRetry: () => void }) {
  switch (line.kind) {
    case 'problem':
      return (
        <FieldError id={id} part="connection-problem" size="xs" className="connection-field-line connection-field-problem">
          {line.word} on the <Link href={line.href}>{line.page}</Link>
        </FieldError>
      )
    case 'loading':
      return (
        <div id={id} className="connection-field-line">
          <Outcome state={{ kind: 'working', label: line.label, startedAt: 0, now: line.seconds * 1000 }} />
        </div>
      )
    case 'failed':
      return (
        <div id={id} className="connection-field-line connection-field-failed">
          <FieldError alert size="xs">{line.sentence}</FieldError>
          <Button variant="secondary" className="btn-sm" onClick={onRetry}>Try again</Button>
        </div>
      )
    case 'empty':
      return (
        <p id={id} className="connection-field-line text-hint">
          {line.before}<Link href={line.href}>{line.page}</Link>{line.after}
        </p>
      )
    case 'gone':
      return <FieldError id={id} alert size="xs" className="connection-field-line">{line.sentence}</FieldError>
  }
}
