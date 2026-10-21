'use client'

/**
 * The Connections page, part 1 (#2338, build PR 9; R1 to R7, R9, R10, R11,
 * R22 to R25), drawn to docs/design/connections-page.html: the list on the
 * left, grouped with Needs attention first, the chosen connection's details on
 * the right (the problem notice, the facts, Used by and History), the Google
 * company list of mailboxes and drives, the stale strip, and the could not
 * load card.
 *
 * Its state is connectionsReducer's (connections-state.ts); this file only
 * lays it out and sends events. What it calls and what time it is come in as
 * props (`source`, `clock`), so the page reads the Worker live and the
 * development preview (/dev/connections) draws the design's fixture through
 * the same component, and tests move time by hand.
 *
 * The data-part attributes are what the settled design's checks read
 * (docs/design/connections-page.checks.js), never a styling hook.
 *
 * Left for build PR 10: the Add connection form, and the Reconnect, Replace and
 * Remove dialogs. Their buttons are drawn where the design puts them and do
 * nothing yet.
 */
import Link from 'next/link'
import { useCallback, useEffect, useId, useMemo, useReducer, useRef } from 'react'
import type { ConnectionList } from '@/lib/api'
import { errorSentence, requestFailureCause } from '@/lib/error-sentence'
import { Button, FieldError, Outcome, TextInput } from '@/components/ui/form'
import { Tabs, TabPanel } from '@/components/ui/Tabs'
import {
  agoText, delegationAdded, delegationKindOf, delegationShown, DELEGATION_KIND_WORDS, etClock, etDay, etMoment, GOOGLE_LIST_ENTRY, historyWhat, isProblem, listGroups,
  problemNotice, secretWordOf, statusWord, viewOf, type ConnectionView, type DelegationEntry, type HistoryEntry,
} from './connection-model'
import {
  chosenConnection, connectionsReducer, currentListAttempt, initialConnectionsState, LIST_NO_ANSWER, type Chosen, type ConnectionsState, type DetailTab, type LoadedList,
} from './connections-state'

/** What the page calls: the Worker's routes live, the fixture in the preview. Each refusal throws as api.ts's req() does. */
export interface ConnectionsSource {
  list(): Promise<ConnectionList>
  history(id: string): Promise<{ entries: HistoryEntry[] }>
  googleSubjects(): Promise<{ subjects: DelegationEntry[]; reached_limit: boolean }>
  addGoogleSubject(body: { kind: DelegationEntry['kind']; subject: string; display_name: string | null }): Promise<{ outcome: 'added' | 'already_listed'; entry: DelegationEntry }>
  removeGoogleSubject(kind: DelegationEntry['kind'], subject: string): Promise<{ outcome: 'removed' }>
}

/** What time it is, and a repeating timer; the preview's stands still. */
export interface ConnectionsClock {
  now(): number
  every(ms: number, fn: () => void): () => void
}

export const browserClock: ConnectionsClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
}

/** The explanation the term "domain wide delegation" carries (D10). */
const DELEGATION_EXPLAINED = 'A Google Workspace grant that lets one service account act as anyone in the company.'

/** What the could not load card says: the design's sentence when the server gave no answer, else the route's own. */
export function loadFailedSentence(cause: string): string {
  return cause === LIST_NO_ANSWER ? `The connections could not be loaded: ${LIST_NO_ANSWER}` : cause
}

/** Why a list load failed: no answer, or the route's own sentence; never a raw fetch error or a status code. */
function listFailureCause(err: unknown): string {
  const e = (err ?? {}) as { body?: unknown; timedOut?: unknown }
  const sentence = e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }).message : undefined
  if (typeof sentence === 'string' && sentence.trim() !== '') return sentence
  return LIST_NO_ANSWER
}

/** A refused change or read, as a plain sentence: the route's, or what failed and the cause measured. */
function changeSentence(err: unknown, what: string): string {
  const body = (err as { body?: unknown } | null)?.body
  if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') return errorSentence(err, what)
  return `${what}: ${requestFailureCause(err)}.`
}

function loadedOf(answer: ConnectionList): LoadedList {
  return { connections: answer.connections.map(viewOf), statuses: { stale: answer.statuses.stale, asOf: answer.statuses.as_of } }
}

export function ConnectionsScreen({ source, clock = browserClock, orgNames = {}, initialChosen, initialTab }: {
  source: ConnectionsSource
  clock?: ConnectionsClock
  /** Salesforce orgs Bidspoke knows by name, by host: the notice names an org by it. */
  orgNames?: Readonly<Record<string, string>>
  initialChosen?: Chosen
  initialTab?: DetailTab
}) {
  const [state, dispatch] = useReducer(connectionsReducer, undefined, () => ({
    ...initialConnectionsState(clock.now(), LIST_DEADLINE_MS, initialChosen),
    tab: initialTab ?? 'connection',
  }))
  const latest = useRef<ConnectionsState>(state)
  latest.current = state

  const loadList = useCallback((attempt: number) => {
    source.list().then(
      (answer) => dispatch({ type: 'list_answered', attempt, data: loadedOf(answer) }),
      (err: unknown) => dispatch({ type: 'list_refused', attempt, cause: listFailureCause(err) }),
    )
  }, [source])

  const loadGoogle = useCallback(() => {
    dispatch({ type: 'google_requested', at: clock.now() })
    source.googleSubjects().then(
      (a) => dispatch({ type: 'google_answered', subjects: a.subjects, reachedLimit: a.reached_limit }),
      (err: unknown) => dispatch({ type: 'google_refused', sentence: changeSentence(err, 'The company list could not be read') }),
    )
  }, [source, clock])

  // The first load, and the company list beside it, so both are there when chosen (L610).
  useEffect(() => {
    loadList(1)
    loadGoogle()
  }, [loadList, loadGoogle])

  const tryAgain = useCallback(() => {
    const attempt = (currentListAttempt(latest.current) ?? latest.current.list.attempt) + 1
    dispatch({ type: 'list_requested', at: clock.now() })
    loadList(attempt)
  }, [clock, loadList])

  // The seconds count while anything waits; otherwise the clock moves twice a minute, for the "4 min ago".
  const waiting = state.list.kind === 'loading'
    || (state.list.kind === 'loaded' && state.list.refresh.kind === 'loading')
    || state.google?.kind === 'loading'
    || state.edit.kind === 'adding' || state.edit.kind === 'removing'
    || Object.values(state.history).some((h) => h.kind === 'loading')
  useEffect(() => clock.every(waiting ? 1000 : 30_000, () => dispatch({ type: 'tick', at: clock.now() })), [clock, waiting])

  const chosen = chosenConnection(state)
  const chosenId = chosen?.id ?? null
  const historyOfChosen = chosenId ? state.history[chosenId] : undefined
  useEffect(() => {
    if (state.tab !== 'history' || !chosenId || historyOfChosen) return
    dispatch({ type: 'history_requested', id: chosenId, at: clock.now() })
    source.history(chosenId).then(
      (a) => dispatch({ type: 'history_answered', id: chosenId, entries: a.entries }),
      (err: unknown) => dispatch({ type: 'history_refused', id: chosenId, sentence: changeSentence(err, "The connection's history could not be read") }),
    )
  }, [state.tab, chosenId, historyOfChosen, source, clock])

  const addEntry = useCallback(() => {
    const s = latest.current
    const text = s.draft.trim()
    if (text === '' || s.edit.kind === 'adding' || s.edit.kind === 'removing' || s.google?.kind !== 'loaded') return
    dispatch({ type: 'add_requested', at: clock.now() })
    source.addGoogleSubject({ kind: delegationKindOf(text), subject: text, display_name: null }).then(
      (a) => dispatch({ type: 'add_answered', entry: a.entry }),
      (err: unknown) => dispatch({ type: 'add_refused', sentence: changeSentence(err, `${text} was not added`) }),
    )
  }, [source, clock])

  const removeEntry = useCallback((entry: DelegationEntry) => {
    const s = latest.current
    if (s.edit.kind === 'adding' || s.edit.kind === 'removing') return
    const shown = delegationShown(entry)
    dispatch({ type: 'remove_requested', entry: { kind: entry.kind, subject: entry.subject }, shown, at: clock.now() })
    source.removeGoogleSubject(entry.kind, entry.subject).then(
      () => dispatch({ type: 'remove_answered', entry: { kind: entry.kind, subject: entry.subject } }),
      (err: unknown) => dispatch({ type: 'remove_refused', sentence: changeSentence(err, `${shown} was not removed`) }),
    )
  }, [source, clock])

  const loaded = state.list.kind === 'loaded' ? state.list : null
  const groups = useMemo(() => (loaded ? listGroups(loaded.data.connections) : []), [loaded])

  return (
    <div className="cx-page">
      <div className="cx-head">
        <h1 className="text-3xl font-bold text-graphite" data-part="page-title">Connections</h1>
        {/* Round 23: hidden until the list loads; round 11b: then always there. Its form is build PR 10's. */}
        {loaded && (
          <div className="cx-head-actions">
            <Button variant="primary" className="cx-btn" part="add-connection">Add connection</Button>
          </div>
        )}
      </div>

      {state.list.kind === 'loading' && (
        <div className="cx-loading">
          <Outcome state={{ kind: 'working', label: 'Loading', startedAt: state.list.startedAt, now: state.now }} />
        </div>
      )}

      {state.list.kind === 'failed' && (
        <div className="cx-card ld-card" data-part="load-failed" role="alert">
          <p>{loadFailedSentence(state.list.cause)}</p>
          <Button variant="secondary" className="cx-btn-quiet" onClick={tryAgain}>Try again</Button>
        </div>
      )}

      {loaded && (
        <>
          {loaded.data.statuses.stale && (
            <div className="un-strip" data-part="stale-strip" role="status">
              <div className="un-strip-text">
                <span>
                  {loaded.data.statuses.asOf
                    ? `Login checks are not answering. Statuses are as of ${etMoment(loaded.data.statuses.asOf, state.now)}.`
                    : 'Login checks are not answering, and no earlier statuses are kept.'}
                </span>
                {loaded.refresh.kind === 'failed' && <FieldError as="span" size="sm" className="un-strip-failed">Trying again did not work: {loaded.refresh.cause}</FieldError>}
              </div>
              {loaded.refresh.kind === 'loading'
                ? <Outcome state={{ kind: 'working', label: 'Trying again', startedAt: loaded.refresh.startedAt, now: state.now }} />
                : <Button variant="secondary" className="cx-btn-quiet" onClick={tryAgain}>Try again</Button>}
            </div>
          )}
          <div className="cx-split">
            <ConnectionList groups={groups} chosen={state.chosen} onChoose={(c) => dispatch({ type: 'choose', chosen: c })} />
            {state.chosen.kind === 'google'
              ? <GooglePanel state={state} onDraft={(text) => dispatch({ type: 'draft', text })} onAdd={addEntry} onRemove={removeEntry} onRetry={loadGoogle} />
              : chosen
                ? <DetailPanel c={chosen} state={state} orgNames={orgNames} onTab={(tab) => dispatch({ type: 'tab', tab })} />
                : null}
          </div>
        </>
      )}
    </div>
  )
}

/** How long the page waits for the list before saying the server did not answer: the client's own ceiling for the call (api.ts). */
export const LIST_DEADLINE_MS = 45_000

function ConnectionList({ groups, chosen, onChoose }: { groups: ReturnType<typeof listGroups>; chosen: Chosen; onChoose: (c: Chosen) => void }) {
  return (
    <nav className="cx-card cx-list" data-part="connection-list" aria-label="Connections">
      {groups.map((g) => (
        <div key={g.heading} className="cx-section">
          <h3 className="cx-group" data-part="group-heading">{g.heading}</h3>
          {g.googleEntry && (
            <div className={`cx-item${chosen.kind === 'google' ? ' sel' : ''}`} data-part="list-item" data-entry="google-subjects" data-selected={chosen.kind === 'google' ? 'true' : undefined}>
              <Button variant="row" className="cx-item-btn" current={chosen.kind === 'google'} onClick={() => onChoose({ kind: 'google' })}>{GOOGLE_LIST_ENTRY}</Button>
            </div>
          )}
          {g.items.map((c) => {
            const on = chosen.kind === 'connection' && chosen.id === c.id
            return (
              <div key={c.id} className={`cx-item${on ? ' sel' : ''}`} data-part="list-item" data-name={c.name} data-selected={on ? 'true' : undefined}>
                <Button variant="row" className="cx-item-btn" current={on} onClick={() => onChoose({ kind: 'connection', id: c.id })}>
                  {g.attention
                    ? (
                      <span className="cx-item-two">
                        <span>{c.name}</span>
                        <span className="cx-hint" data-part="item-problem">{c.serviceName}, {(statusWord(c.status) ?? '').toLowerCase()}</span>
                      </span>
                    )
                    : <span>{c.name}</span>}
                </Button>
              </div>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function StatusLine({ c }: { c: ConnectionView }) {
  const word = statusWord(c.status)
  return (
    <span className={`cx-status${isProblem(c) ? ' problem' : ''}`} data-part="status" data-status={c.status ?? 'unknown'}>
      <span className="dot" aria-hidden="true" />
      {word ?? 'Status not known'}
    </span>
  )
}

function WorkflowLinks({ workflows }: { workflows: ConnectionView['workflows'] }) {
  return (
    <>
      {workflows.map((w) => (w.deleted
        ? <span key={w.id} className="cx-wf cx-wf-gone">{w.name} (deleted)</span>
        : <Link key={w.id} href={`/workflows/${w.id}`} className="cx-wf" data-part="workflow-link">{w.name}</Link>))}
    </>
  )
}

function DetailPanel({ c, state, orgNames, onTab }: { c: ConnectionView; state: ConnectionsState; orgNames: Readonly<Record<string, string>>; onTab: (t: DetailTab) => void }) {
  const notice = problemNotice(c, state.now, orgNames)
  const n = c.workflows.length
  const facts: Array<[string, string]> = [
    ['Service', c.serviceName],
    ['Acts as', c.actsAs ?? 'Not yet known'],
    ...(c.org ? [['Org', c.org] as [string, string]] : []),
    ['Last checked', c.lastCheckedAt ? agoText(c.lastCheckedAt, state.now) : 'Not checked yet'],
  ]
  const history = state.history[c.id]
  return (
    <section className="cx-card cx-detail" data-part="detail" aria-label={c.name}>
      <h2>{c.name}</h2>
      <StatusLine c={c} />
      <Tabs
        label={`${c.name}`}
        value={state.tab}
        onValueChange={onTab}
        className="cx-tabs"
        items={[{ value: 'connection', label: 'Connection' }, { value: 'used_by', label: `Used by (${n})` }, { value: 'history', label: 'History' }]}
      >
        <TabPanel value="connection">
          {notice && (
            <div className="cx-notice" data-part="problem-notice">
              <p>{notice.cause}</p>
              {notice.effect && <p>{notice.effect}</p>}
              <p className="cx-hint">{notice.fix}</p>
              {!c.alertLogin && <Button variant="primary" className="cx-btn cx-btn-sm">Reconnect</Button>}
            </div>
          )}
          <div className="cx-rows">
            {facts.map(([label, value]) => (
              <div key={label} className="cx-row" data-part="fact" data-fact={label}>
                <div>{label}</div>
                <div>{value}</div>
              </div>
            ))}
          </div>
          {c.alertLogin
            ? (
              <p className="cx-aside">
                Its token and the alerts it posts are set on the <Link href="/integrations" className="cx-link">Integrations page</Link>.
              </p>
            )
            : (
              <>
                {/* Rounds 6 and 9c. Reconnect, Replace and Remove open dialogs that build PR 10 adds. */}
                <div className="cx-actions" data-part="actions">
                  {!notice && <Button variant="secondary" className="cx-btn-quiet">Reconnect</Button>}
                  <Button variant="secondary" className="cx-btn-quiet">Replace</Button>
                </div>
                <div className="cx-danger" data-part="remove-row">
                  {n > 0 && <div className="what">Cannot be removed while a workflow uses it.</div>}
                  <Button variant="danger" className="cx-btn-danger" disabled={n > 0}>Remove</Button>
                </div>
                {n > 0 && (
                  <div className="cx-inline" data-part="used-by">
                    <div>Used by:</div>
                    <WorkflowLinks workflows={c.workflows} />
                  </div>
                )}
              </>
            )}
        </TabPanel>
        <TabPanel value="used_by">
          {n > 0
            ? <div className="cx-tab-list"><WorkflowLinks workflows={c.workflows} /></div>
            : <p className="cx-empty">No workflow uses it.</p>}
        </TabPanel>
        <TabPanel value="history">
          <HistoryList state={history} now={state.now} secret={secretWordOf(c)} />
        </TabPanel>
      </Tabs>
    </section>
  )
}

function HistoryList({ state, now, secret }: { state: ConnectionsState['history'][string] | undefined; now: number; secret: string }) {
  if (!state || state.kind === 'loading') {
    return <div className="cx-empty"><Outcome state={{ kind: 'working', label: 'Loading the history', startedAt: state?.startedAt ?? now, now }} /></div>
  }
  if (state.kind === 'failed') return <FieldError alert className="cx-empty">{state.sentence}</FieldError>
  if (state.entries.length === 0) return <p className="cx-empty">No change is recorded.</p>
  return (
    <div className="cx-history">
      {state.entries.map((e) => (
        <div key={e.id} className="cx-history-row" data-part="history-row">
          <div>{etDay(e.at)}</div>
          <div>{etClock(e.at)}</div>
          <div>{e.by ?? 'Bidspoke'}</div>
          <div>{historyWhat(e, secret)}</div>
        </div>
      ))}
    </div>
  )
}

function GooglePanel({ state, onDraft, onAdd, onRemove, onRetry }: {
  state: ConnectionsState
  onDraft: (text: string) => void
  onAdd: () => void
  onRemove: (e: DelegationEntry) => void
  onRetry: () => void
}) {
  const inputId = useId()
  const termId = useId()
  const g = state.google
  const edit = state.edit
  const busy = edit.kind === 'adding' || edit.kind === 'removing'
  return (
    <section className="cx-card cx-detail" data-part="google-subjects" aria-label="Google mailboxes and drives">
      <h2>Google mailboxes and drives</h2>
      <p className="ga-intro">
        Google connections act as a mailbox or shared drive through{' '}
        {/* The term takes focus so its explanation shows to a keyboard as it does under a pointer (L604, D10); it does nothing else. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <span className="ga-term" data-part="term" tabIndex={0} aria-describedby={termId} aria-description={DELEGATION_EXPLAINED} data-explain={DELEGATION_EXPLAINED}>domain wide delegation</span>
        <span id={termId} className="sr-only">{DELEGATION_EXPLAINED}</span>
        . They may act only as the ones listed here.
      </p>
      {(!g || g.kind === 'loading') && (
        <div className="cx-empty"><Outcome state={{ kind: 'working', label: 'Loading the company list', startedAt: g?.startedAt ?? state.now, now: state.now }} /></div>
      )}
      {g?.kind === 'failed' && (
        <div className="ga-failed">
          <FieldError alert>{g.sentence}</FieldError>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onRetry}>Try again</Button>
        </div>
      )}
      {g?.kind === 'loaded' && (
        <>
          {g.subjects.length === 0 && <p className="cx-empty">Nothing is on the list yet.</p>}
          {g.subjects.map((e) => (
            <div key={`${e.kind}:${e.subject}`} className="ga-row" data-part="subject-row">
              <div>{delegationShown(e)}</div>
              <div className="cx-hint">{DELEGATION_KIND_WORDS[e.kind]}</div>
              <div className="cx-hint">{delegationAdded(e)}</div>
              <Button variant="quiet" className="ga-link" disabled={busy} onClick={() => onRemove(e)} aria-label={`Remove ${delegationShown(e)}`}>Remove</Button>
            </div>
          ))}
          {g.reachedLimit && <p className="cx-hint ga-limit">The list holds more entries than are shown here.</p>}
          <div className="ga-add" data-part="subject-add">
            <TextInput
              id={inputId}
              value={state.draft}
              onChange={onDraft}
              onEnter={onAdd}
              disabled={busy}
              placeholder="Mailbox address or shared drive name"
              aria-label="Mailbox address or shared drive name"
            />
            <Button variant="primary" className="cx-btn cx-btn-sm" onClick={onAdd} disabled={busy || state.draft.trim() === ''}>Add</Button>
          </div>
          {edit.kind === 'adding' && <div className="ga-edit"><Outcome state={{ kind: 'working', label: `Adding ${edit.text}`, startedAt: edit.startedAt, now: state.now }} /></div>}
          {edit.kind === 'removing' && <div className="ga-edit"><Outcome state={{ kind: 'working', label: `Removing ${edit.shown}`, startedAt: edit.startedAt, now: state.now }} /></div>}
          {edit.kind === 'failed' && <FieldError alert className="ga-edit">{edit.sentence}</FieldError>}
        </>
      )}
    </section>
  )
}
