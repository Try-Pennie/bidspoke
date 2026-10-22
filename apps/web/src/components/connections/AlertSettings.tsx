'use client'

/**
 * The Slack alerts login's alert settings (#2338, build PR 14; Dan's decision
 * 1 of 2026-10-21), drawn as design round 36 settled them ("On the login's
 * panel", docs/design/connections-page.html frame alert-login): an Alerts
 * heading under the login's facts, the channel the alerts post to with
 * Change, and the four alert switches, each with one plain line of what it
 * watches.
 *
 * Its state is the page reducer's (alert-settings-state.ts); this lays it out
 * and sends events. Change opens the app's dropdown in its searched form
 * (Combobox `search`), which asks Slack for the channels holding what is
 * typed, as the Integrations page's editor did, and Save moves the alerts
 * there. A switch says it started (the working line, the seconds counting),
 * what it did, and turns back with a plain red sentence if its save fails
 * (L608).
 *
 * The data-part attributes are what the settled design's checks read
 * (docs/design/connections-page.checks.js), never a styling hook.
 */
import { useCallback, useId, useMemo } from 'react'
import { Button, FieldError, Outcome } from '@/components/ui/form'
import { Toggle } from '@/components/ui/Toggle'
import { ComboboxControl, realClock, useSearchLoad, type ComboboxClock, type ComboboxOption } from '@/components/ui/Combobox'
import { ALERT_SWITCHES, CHANNEL_SEARCH_MIN, channelSaved, NOT_CONNECTED, POSTS_TO, switchSaved, switchWorking, type AlertSwitchKey } from './alert-settings-model'
import type { AlertsState } from './alert-settings-state'

/** How long a channel search may take before the menu says it did not answer: the client's own ceiling for the call (api.ts). */
const SEARCH_DEADLINE_MS = 30_000

export function AlertSettings({ state, now, onToggle, onChannelOpen, onChannelChosen, onChannelSave, onChannelClose, searchChannels, onRetry, initialChannelQuery, clock = realClock }: {
  state: AlertsState
  now: number
  onToggle: (key: AlertSwitchKey, to: boolean) => void
  onChannelOpen: () => void
  onChannelChosen: (channel: string) => void
  onChannelSave: () => void
  onChannelClose: () => void
  /** Slack's channels holding the text, as "#name"; a refusal throws a sentence, which the menu shows as it is. */
  searchChannels: (query: string, signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  onRetry: () => void
  /** What the channel box opens holding: only the development preview passes it, to draw the open menu. */
  initialChannelQuery?: string
  clock?: ComboboxClock
}) {
  const base = useId()
  const load = state.load
  return (
    <div className="cx-alerts" data-part="alert-settings">
      <h3 className="cx-group cx-alerts-heading" data-part="alerts-heading">Alerts</h3>
      {load.kind === 'loading' && (
        <div className="cx-empty"><Outcome state={{ kind: 'working', label: 'Loading the alert settings', startedAt: load.startedAt, now }} /></div>
      )}
      {load.kind === 'failed' && (
        <div className="ga-failed">
          <FieldError alert size="sm" part="alerts-line" partState="failed">{load.sentence}</FieldError>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onRetry}>Try again</Button>
        </div>
      )}
      {/* No way to connect a first alert bot from the app since the Integrations page went: #2642. */}
      {load.kind === 'none' && <p className="cx-empty">{NOT_CONNECTED}</p>}
      {load.kind === 'loaded' && (
        <div className="cx-rows cx-alert-rows">
          <div className="cx-row cx-alert-channel-row" data-part="alert-channel">
            <div>{POSTS_TO}</div>
            <ChannelValue
              id={`${base}-channel`}
              state={state}
              now={now}
              onOpen={onChannelOpen}
              onChosen={onChannelChosen}
              onSave={onChannelSave}
              onClose={onChannelClose}
              searchChannels={searchChannels}
              initialQuery={initialChannelQuery}
              clock={clock}
            />
          </div>
          {ALERT_SWITCHES.map((sw) => {
            const on = load.settings.switches[sw.key]
            const save = state.switches[sw.key]
            const hintId = `${base}-${sw.key}-hint`
            return (
              <div key={sw.key} className="cx-row cx-switch-row" data-part="alert-switch" data-switch={sw.key}>
                <div>
                  <div>{sw.name}</div>
                  <div id={hintId} className="cx-hint">{sw.watches}</div>
                  {save.kind === 'saving' && (
                    <div className="cx-alert-line" data-part="switch-line" data-state="saving">
                      <Outcome state={{ kind: 'working', label: switchWorking(sw.key, save.to), startedAt: save.startedAt, now }} />
                    </div>
                  )}
                  {save.kind === 'saved' && (
                    <p role="status" className="cx-alert-line" data-part="switch-line" data-state="saved">{switchSaved(save.to)}</p>
                  )}
                  {save.kind === 'failed' && (
                    <FieldError alert size="sm" className="cx-alert-line" part="switch-line" partState="failed">{save.sentence}</FieldError>
                  )}
                </div>
                <div className="cx-switch">
                  <Toggle id={`${base}-${sw.key}`} label={sw.name} checked={on} describedBy={hintId} onChange={(to) => onToggle(sw.key, to)} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChannelValue({ id, state, now, onOpen, onChosen, onSave, onClose, searchChannels, initialQuery, clock }: {
  id: string
  state: AlertsState
  now: number
  onOpen: () => void
  onChosen: (channel: string) => void
  onSave: () => void
  onClose: () => void
  searchChannels: (query: string, signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  initialQuery?: string
  clock: ComboboxClock
}) {
  const saved = state.load.kind === 'loaded' ? state.load.settings.channel : null
  const editor = state.channel
  if (editor.kind === 'closed') {
    return (
      <div className="cx-alert-channel">
        <div className="cx-alert-channel-line">
          <span data-part="alert-channel-value">{saved ?? 'No channel is set'}</span>
          <Button variant="secondary" className="cx-btn-quiet" onClick={onOpen}>Change</Button>
        </div>
        {editor.saved && <p role="status" className="cx-alert-line" data-part="channel-line" data-state="saved">{channelSaved(editor.saved)}</p>}
      </div>
    )
  }
  return (
    <div className="cx-alert-channel">
      <ChannelEditor
        id={id}
        chosen={editor.chosen}
        saving={editor.save.kind === 'saving'}
        onChosen={onChosen}
        onSave={onSave}
        onClose={onClose}
        searchChannels={searchChannels}
        initialQuery={initialQuery}
        clock={clock}
      />
      {editor.save.kind === 'saving' && (
        <div className="cx-alert-line" data-part="channel-line" data-state="saving">
          <Outcome state={{ kind: 'working', label: `Moving the alerts to ${editor.save.channel}`, startedAt: editor.save.startedAt, now }} />
        </div>
      )}
      {editor.save.kind === 'failed' && <FieldError alert size="sm" className="cx-alert-line" part="channel-line" partState="failed">{editor.save.sentence}</FieldError>}
    </div>
  )
}

function ChannelEditor({ id, chosen, saving, onChosen, onSave, onClose, searchChannels, initialQuery, clock }: {
  id: string
  chosen: string | null
  saving: boolean
  onChosen: (channel: string) => void
  onSave: () => void
  onClose: () => void
  searchChannels: (query: string, signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  initialQuery?: string
  clock: ComboboxClock
}) {
  const search = useCallback((q: string, signal: AbortSignal) => searchChannels(q, signal), [searchChannels])
  const { list, onSearch } = useSearchLoad(search, { minChars: CHANNEL_SEARCH_MIN, initialQuery, deadlineMs: SEARCH_DEADLINE_MS, clock, stalledMessage: `Slack did not answer within ${SEARCH_DEADLINE_MS / 1000} seconds. Try again.` })
  const searchProps = useMemo(() => ({
    onSearch,
    minChars: CHANNEL_SEARCH_MIN,
    prompt: "Type at least 3 letters of the channel's name.",
    placeholder: 'Search the channels',
    initialQuery,
  }), [onSearch, initialQuery])
  return (
    <div className="cx-alert-editor" data-part="channel-editor">
      <ComboboxControl
        id={id}
        aria-label="The channel alerts post to"
        value={chosen ?? ''}
        onChange={(v) => onChosen(v)}
        list={list}
        clock={clock}
        emptyMessage="No channel holds those letters."
        disabled={saving}
        search={searchProps}
      />
      <Button variant="primary" className="cx-btn cx-btn-sm" onClick={onSave} disabled={saving || chosen === null}>Save</Button>
      <Button variant="secondary" className="cx-btn-quiet" onClick={onClose}>Cancel</Button>
    </div>
  )
}
