/**
 * The development preview's data for a step's Connection field (#2338, build
 * PR 11): the settled design's own fixture
 * (docs/design/connections-step-form.fixture.json) turned into what
 * GET /api/connections answers, and the workflow the design's captured canvas
 * shows (Achieve report import, its Salesforce step open). No network: every
 * frame's list is answered, refused or held here. Not served in a production
 * build.
 */
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import type { ComboboxClock } from '@/components/ui/Combobox'
import type { Workflow } from '@/types/workflow'
import fixture from '../../../../../../docs/design/connections-step-form.fixture.json'

/** The settled frames (docs/design/connections-step-form/settled.json): the design score's built side. */
export const SETTLED_FRAMES = ['step-healthy', 'step-problem', 'step-failing'] as const

/** The states the settled design never drew, each its own frame for the design round to look at. */
export const UNDRAWN_FRAMES = ['none-chosen', 'menu-open', 'loading', 'failed', 'refused', 'empty', 'gone'] as const

export type PreviewFrame = (typeof SETTLED_FRAMES)[number] | (typeof UNDRAWN_FRAMES)[number]

const FRAMES: readonly string[] = [...SETTLED_FRAMES, ...UNDRAWN_FRAMES]

export function previewFrameOf(frame: string | undefined): PreviewFrame {
  return (frame && FRAMES.includes(frame) ? frame : 'step-healthy') as PreviewFrame
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
/** A fixture connection's id, made up and shaped as an id, never shown. */
export const idOf = (name: string) => `0000${slug(name)}`

type FixtureConnection = (typeof fixture.connections)[number]

function rowOf(c: FixtureConnection): ConnectionListRow {
  const status = c.status as 'ok' | 'reauth' | 'failing'
  return {
    id: idOf(c.name),
    name: c.name,
    service: slug(c.service),
    service_name: c.service,
    alert_login: false,
    acts_as: c.actsAs,
    person_bound: false,
    owner: null,
    target: null,
    status,
    status_word: fixture.statusVocabulary[status],
    health: null,
    used_by: 1,
    workflows: [],
    created_at: '2026-10-01T16:00:00Z',
    updated_at: '2026-10-01T16:00:00Z',
  }
}

export const PREVIEW_LIST: ConnectionList = {
  connections: fixture.connections.map(rowOf),
  statuses: { as_of: '2026-10-20T16:00:00Z', stale: false, unavailable: null },
}

/** Which connection each frame's step has chosen, by the fixture's name; null for none. */
export function chosenIdOf(frame: PreviewFrame): string | null {
  switch (frame) {
    case 'step-problem': return idOf('Achieve Salesforce')
    case 'step-failing': return idOf('Lendco Salesforce')
    case 'none-chosen': case 'menu-open': case 'empty': return null
    case 'gone': return idOf('Removed Salesforce')
    default: return idOf('Pennie Salesforce')
  }
}

/** How each frame's list answers: the fixture, nothing of the service, a refusal, no answer, or held. */
export function previewLoadList(frame: PreviewFrame): () => Promise<ConnectionList> {
  switch (frame) {
    case 'loading': return () => new Promise<ConnectionList>(() => {})
    // The client's own timeout gives no body, which the field reads as no answer.
    case 'failed': return () => Promise.reject(Object.assign(new Error('timed out'), { timedOut: true }))
    case 'refused': return () => Promise.reject(Object.assign(new Error('HTTP 503'), { body: { message: 'The connections could not be read: the use counts read failed.' } }))
    case 'empty': return () => Promise.resolve({ ...PREVIEW_LIST, connections: [] })
    default: return () => Promise.resolve(PREVIEW_LIST)
  }
}

/**
 * A clock that stands still, so a counting state always reads the same: the
 * loading frame reads 6 seconds in. It reads the start until the first
 * heartbeat, which runs at once, and `elapsedMs` later from then on; a
 * heartbeat asked for after that never runs, nor does the deadline.
 */
export function stillClock(elapsedMs: number): ComboboxClock {
  const start = Date.parse('2026-10-20T16:00:00Z')
  let moved = false
  return {
    now: () => (moved ? start + elapsedMs : start),
    setTimeout: (fn, ms) => {
      if (ms === 1000 && !moved) queueMicrotask(() => { moved = true; fn() })
      return 0
    },
    clearTimeout: () => {},
  }
}

/** The workflow the design's captured canvas shows, its Salesforce step the one open. */
export const PREVIEW_WORKFLOW: Workflow = {
  id: '00000000-0000-4000-8000-000000002338',
  name: 'Achieve report import',
  is_active: true,
  test_payloads: [],
  created_at: '2026-10-01T16:00:00Z',
  updated_at: '2026-10-20T16:00:00Z',
  definition: {
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [
      { id: 'n1', namespace: fixture.step.stepId, label: fixture.step.displayName, type: 'salesforce', position: { x: 80, y: 240 }, config: {} },
      { id: 'n2', namespace: 'shape_rows', label: 'Shape rows', type: 'transform', position: { x: 80, y: 400 }, config: {} },
      { id: 'n3', namespace: 'respond', label: 'Respond', type: 'response', position: { x: 80, y: 560 }, config: { status_code: 200 } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
      { id: 'e3', source: 'n2', target: 'n3' },
    ],
  },
}

/** The step's own fields the design draws around the Connection field, from the fixture. */
export const PREVIEW_STEP = fixture.step
