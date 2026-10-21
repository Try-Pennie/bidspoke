/**
 * The development preview of a step's Connection field (#2338 build PR 11):
 * every frame, settled or never drawn, reached by its id alone, draws its state
 * through the real ConnectionField from the settled design's own fixture, holds
 * a counting state still, and fetches nothing. The page answers 404 in a
 * production build.
 */
import { act, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionField } from '@/components/connections/ConnectionField'
import { realClock } from '@/components/ui/Combobox'
import fixture from '../../../../../../../docs/design/connections-step-form.fixture.json'
import { chosenIdOf, idOf, PREVIEW_LIST, previewFrameOf, previewLoadList, SETTLED_FRAMES, stillClock, UNDRAWN_FRAMES, type PreviewFrame } from '../connection-field-preview-source'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { connections: { list: () => { throw new Error('the preview called the live list') } } } }))
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ notFound: () => notFound() }))

/** What each frame must show under or in the field, read from the rendered text. */
const SHOWS: Record<PreviewFrame, string[]> = {
  'step-healthy': ['Pennie Salesforce', 'Acts as integration@trypennie.com'],
  'step-problem': ['Achieve Salesforce', 'Acts as pennie.api@achieve.example', 'Needs reconnecting on the Connections page'],
  'step-failing': ['Lendco Salesforce', 'Acts as api@lendco.example', 'Check failing on the Connections page'],
  'none-chosen': ['Choose a connection'],
  'menu-open': ['Choose a connection'],
  'loading': ['Loading the connections, 6 s'],
  'failed': ["The connections could not be loaded: Bidspoke's server did not answer.", 'Try again'],
  'refused': ['The connections could not be read: the use counts read failed.', 'Try again'],
  'empty': ['No Salesforce connection yet. Add one on the Connections page.'],
  'gone': ['Choose a connection', 'The connection this step used no longer exists. Choose another.'],
}

function Frame({ frame }: { frame: PreviewFrame }) {
  return (
    <ConnectionField
      id="step-connection"
      service="salesforce"
      value={chosenIdOf(frame)}
      onChange={() => {}}
      loadList={previewLoadList(frame)}
      clock={frame === 'loading' ? stillClock(6000) : realClock}
    />
  )
}

afterEach(() => { vi.unstubAllEnvs() })

describe('the Connection field preview', () => {
  it('lists the settled frames exactly as the settled design does', () => {
    const spec = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../../../docs/design/connections-step-form/settled.json'), 'utf8')) as { frames: { id: string }[] }
    expect([...SETTLED_FRAMES]).toEqual(spec.frames.map((f) => f.id))
  })

  it("answers the list from the design's fixture: every connection, its acts as and its status word", () => {
    expect(PREVIEW_LIST.connections.map((c) => [c.name, c.acts_as, c.status_word])).toEqual(
      fixture.connections.map((c) => [c.name, c.actsAs, fixture.statusVocabulary[c.status as keyof typeof fixture.statusVocabulary]]),
    )
  })

  it('an unknown frame id opens the healthy frame', () => {
    expect(previewFrameOf('nonsense')).toBe('step-healthy')
    expect(previewFrameOf(undefined)).toBe('step-healthy')
  })

  for (const frame of [...SETTLED_FRAMES, ...UNDRAWN_FRAMES]) {
    it(`${frame}: draws its state with nothing fetched`, async () => {
      render(<Frame frame={frame} />)
      await act(async () => {})
      await act(async () => {})
      const field = document.querySelector('[data-part="connection-field"]') as HTMLElement
      for (const text of SHOWS[frame]) expect(field.textContent?.replace(/\s+/g, ' ')).toContain(text)
      // A connection's id is never shown, in any frame.
      for (const c of fixture.connections) expect(field.textContent).not.toContain(idOf(c.name))
      expect(field.textContent).not.toContain(idOf('Removed Salesforce'))
    })
  }

  it('the loading frame stands still at 6 seconds', async () => {
    render(<Frame frame="loading" />)
    await act(async () => {})
    expect(within(screen.getByRole('status')).getByText(/6 s/)).toBeInTheDocument()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('status')).toHaveTextContent('Loading the connections, 6 s')
  })

  it('the page answers 404 in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { default: Page } = await import('../page')
    await expect(Page({ searchParams: Promise.resolve({ frame: 'step-healthy' }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
