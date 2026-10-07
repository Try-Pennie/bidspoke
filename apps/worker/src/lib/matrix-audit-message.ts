/**
 * The "Bid matrix changed" Slack message for one matrix (#1864).
 *
 * Settled in design rounds on 2026-10-07; the rendering and the reason for each
 * decision are in docs/design/bid-matrix-alert.html. In short: a fixed title,
 * then labelled lines for the matrix, who changed it and when, and how many
 * bids, then a grid with Debt down the side and Vantage across showing only the
 * rows and columns that changed, each cell the new bid with how far it moved.
 */

import { etClock } from './archive-gate'

export interface Band {
  low: number | null
  high: number | null
}

/** One cell of a matrix that differs from the snapshot. A null side is a bid added or deleted. */
export interface MatrixCellChange {
  debt: Band
  vantage: Band
  before: number | null
  after: number | null
}

export interface MatrixAuditAlert {
  /** "Borrow Better", or "Default" for the rows no partner claims. */
  matrix: string
  is_sell_off: boolean
  cells: MatrixCellChange[]
  /** Everyone who saved this matrix since the last run, from Salesforce's LastModifiedBy. */
  editors: string[]
  edited_from: string | null
  edited_to: string | null
  /** The rows deleted since the last run could not be read, so only the last save is known. */
  earlier_saves_unread?: boolean
}

/** Slack refuses a section whose text is longer than this. */
export const SLACK_SECTION_LIMIT = 3000
const FENCE = '```'
const UNCHANGED = '·'
const ET = 'America/New_York'

export function bandLabel(band: Band, axis: 'debt' | 'vantage'): string {
  const { low, high } = band
  const num = (n: number) => (axis === 'debt' ? n.toLocaleString('en-US') : String(n))
  if (low === 0 && high === 0) return 'any'
  if (low === null && high === null) return 'any'
  if (low === null) return `up to ${num(high as number)}`
  // The top band is stored with a sentinel ceiling (2,000,000 of debt, a
  // Vantage of 1,000) that means "and up".
  const openTop = high === null || (axis === 'debt' ? high >= 1_000_000 : high >= 1000)
  if (openTop) return `${num(low)}+`
  return `${num(low)}-${num(high)}`
}

function cents(n: number): number {
  return Math.round(n * 100) / 100
}

function amount(n: number): string {
  const v = cents(n)
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

function cellText(c: MatrixCellChange): string {
  if (c.after === null) return 'gone'
  if (c.before === null) return `$${amount(c.after)} (new)`
  const delta = cents(c.after - c.before)
  return `$${amount(c.after)} (${delta >= 0 ? '+' : '-'}${amount(Math.abs(delta))})`
}

function bandKey(b: Band): string {
  return `${b.low}|${b.high}`
}

function uniqueBands(bands: Band[]): Band[] {
  const seen = new Map<string, Band>()
  for (const b of bands) if (!seen.has(bandKey(b))) seen.set(bandKey(b), b)
  return [...seen.values()].sort((a, b) => (a.low ?? -Infinity) - (b.low ?? -Infinity) || (a.high ?? Infinity) - (b.high ?? Infinity))
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length))
}

/**
 * The grid as one or more blocks of fixed width text, each short enough for one
 * Slack section once fenced, with the header row repeated on each.
 */
export function formatGrid(cells: MatrixCellChange[]): string[] {
  const rows = uniqueBands(cells.map((c) => c.debt))
  const cols = uniqueBands(cells.map((c) => c.vantage))
  const byCell = new Map(cells.map((c) => [`${bandKey(c.debt)}#${bandKey(c.vantage)}`, cellText(c)]))

  const rowLabels = rows.map((r) => bandLabel(r, 'debt'))
  const colLabels = cols.map((c) => bandLabel(c, 'vantage'))
  const firstWidth = Math.max('Debt $'.length, ...rowLabels.map((l) => l.length)) + 2
  const texts = rows.map((r) => cols.map((c) => byCell.get(`${bandKey(r)}#${bandKey(c)}`) ?? UNCHANGED))
  const widths = cols.map((_, j) => Math.max(colLabels[j].length, ...texts.map((t) => t[j].length)) + 2)

  const line = (first: string, rest: string[]) =>
    (pad(first, firstWidth) + rest.map((t, j) => pad(t, widths[j])).join('')).trimEnd()
  const header = line('Debt $', colLabels)
  const body = rows.map((_, i) => line(rowLabels[i], texts[i]))

  const budget = SLACK_SECTION_LIMIT - (FENCE.length * 2 + 2)
  const parts: string[] = []
  let current = header
  for (const l of body) {
    if (current !== header && current.length + 1 + l.length > budget) {
      parts.push(current)
      current = header
    }
    current += '\n' + l
  }
  parts.push(current)
  return parts
}

function names(editors: string[]): string {
  if (editors.length <= 1) return editors[0] ?? ''
  return `${editors.slice(0, -1).join(', ')} and ${editors[editors.length - 1]}`
}

function etDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
}

function spokenEtDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' }).format(instant)
}

/** "7:07 to 7:25 PM ET", dated when the edit was not on the day the alert goes out. */
function editWindow(fromIso: string, toIso: string, now: Date): string {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  const clock = (d: Date) => etClock(d).replace(/ ET$/, '')
  if (etDay(from) !== etDay(to)) {
    return `${spokenEtDay(from)}, ${clock(from)} to ${spokenEtDay(to)}, ${clock(to)} ET`
  }
  const dated = etDay(to) === etDay(now) ? '' : `${spokenEtDay(to)}, `
  if (clock(from) === clock(to)) return `${dated ? dated : 'at '}${clock(to)} ET`
  const meridiem = (s: string) => s.slice(-2)
  const start = meridiem(clock(from)) === meridiem(clock(to)) ? clock(from).slice(0, -3) : clock(from)
  return `${dated}${start} to ${clock(to)} ET`
}

function changedBy(alert: MatrixAuditAlert, now: Date): string {
  if (alert.editors.length === 0 || !alert.edited_from || !alert.edited_to) return 'not recorded in Salesforce'
  if (alert.earlier_saves_unread) {
    return `${names(alert.editors)}, last saved ${editWindow(alert.edited_to, alert.edited_to, now)}`
  }
  return `${names(alert.editors)}, ${editWindow(alert.edited_from, alert.edited_to, now)}`
}

export function buildMatrixAuditMessage(
  alert: MatrixAuditAlert,
  now: Date,
  matrixUrl: string | undefined,
): { blocks: unknown[]; text: string } {
  const count = alert.cells.length
  const kind = alert.is_sell_off ? 'sell-off' : 'regular, not sell-off'
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Bid matrix changed', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Matrix:* ${alert.matrix} (${kind})`,
          `*Changed by:* ${changedBy(alert, now)}`,
          `*Bids changed:* ${count}`,
        ].join('\n'),
      },
    },
    ...formatGrid(alert.cells).map((g) => ({ type: 'section', text: { type: 'mrkdwn', text: `${FENCE}\n${g}\n${FENCE}` } })),
  ]
  if (matrixUrl) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${matrixUrl}|Open in Salesforce →>` } })
  }
  const by = alert.editors.length > 0 ? `, by ${names(alert.editors)}` : ''
  const text = `Bid matrix changed: ${alert.matrix}, ${count} bid${count === 1 ? '' : 's'}${by}`
  return { blocks, text }
}
