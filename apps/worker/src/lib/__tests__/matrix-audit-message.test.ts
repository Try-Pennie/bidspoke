import { describe, it, expect } from 'vitest'
import {
  buildMatrixAuditMessage,
  formatGrid,
  bandLabel,
  SLACK_SECTION_LIMIT,
  type MatrixAuditAlert,
  type MatrixCellChange,
} from '../matrix-audit-message'

// The settled design (docs/design/bid-matrix-alert.html, #1864). The grid text
// is the design itself, so it is asserted whole.

function cell(debt: [number, number], vantage: [number, number], before: number | null, after: number | null): MatrixCellChange {
  return {
    debt: { low: debt[0], high: debt[1] },
    vantage: { low: vantage[0], high: vantage[1] },
    before,
    after,
  }
}

// The real 2026-09-29 AmOne Direct edit, recovered from the Salesforce recycle bin.
const SEP_29: MatrixAuditAlert = {
  matrix: 'AmOne Direct',
  is_sell_off: false,
  editors: ['Pat Example'],
  edited_from: '2026-09-29T23:07:45.000Z',
  edited_to: '2026-09-29T23:25:06.000Z',
  cells: [
    cell([19000, 29999], [550, 600], 14, 12),
    cell([19000, 29999], [601, 660], 14, 12),
    cell([19000, 29999], [661, 780], 14, 12),
    cell([30000, 39999], [550, 600], 22, 14),
    cell([30000, 39999], [601, 660], 22, 14),
    cell([30000, 39999], [661, 780], 22, 14),
    cell([30000, 39999], [781, 850], 20, 14),
  ],
}
const SEP_29_ALERT_TIME = new Date('2026-09-30T00:00:40.000Z')

function sectionTexts(blocks: unknown[]): string[] {
  return (blocks as Array<{ type: string; text?: { text: string } }>)
    .filter((b) => b.type === 'section')
    .map((b) => b.text!.text)
}

describe('formatGrid', () => {
  it('draws only the changed rows and columns, with the new bid and how far it moved', () => {
    expect(formatGrid(SEP_29.cells)).toEqual([
      [
        'Debt $         550-600   601-660   661-780   781-850',
        '19,000-29,999  $12 (-2)  $12 (-2)  $12 (-2)  ·',
        '30,000-39,999  $14 (-8)  $14 (-8)  $14 (-8)  $14 (-6)',
      ].join('\n'),
    ])
  })

  it('marks a new bid and a deleted one in words, and keeps cents', () => {
    const grid = formatGrid([
      cell([15000, 15999], [301, 499], null, 6),
      cell([16000, 16999], [301, 499], 6.1, null),
      cell([17000, 17999], [301, 499], 6.2, 6.15),
      cell([18000, 18999], [301, 499], 6, 7.5),
    ])[0]
    expect(grid).toContain('$6 (new)')
    expect(grid).toContain('gone')
    expect(grid).toContain('$6.15 (-0.05)')
    expect(grid).toContain('$7.50 (+1.50)')
  })

  it('splits a grid too long for one Slack section, repeating the header on each part', () => {
    const many: MatrixCellChange[] = []
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 5; j++) {
        many.push(cell([i * 1000, i * 1000 + 999], [300 + j * 100, 399 + j * 100], 10, 11))
      }
    }
    const parts = formatGrid(many)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length + '```\n\n```'.length).toBeLessThanOrEqual(SLACK_SECTION_LIMIT)
      expect(p.startsWith('Debt $')).toBe(true)
    }
    const dataLines = parts.flatMap((p) => p.split('\n').slice(1))
    expect(dataLines).toHaveLength(60)
  })
})

describe('bandLabel', () => {
  it('shows an open top band as a plus, and a 0 to 0 placeholder as any', () => {
    expect(bandLabel({ low: 100000, high: 2000000 }, 'debt')).toBe('100,000+')
    expect(bandLabel({ low: 720, high: 1000 }, 'vantage')).toBe('720+')
    expect(bandLabel({ low: 781, high: 850 }, 'vantage')).toBe('781-850')
    expect(bandLabel({ low: 0, high: 0 }, 'debt')).toBe('any')
    expect(bandLabel({ low: 0, high: 18999 }, 'debt')).toBe('0-18,999')
  })
})

describe('buildMatrixAuditMessage', () => {
  it('opens with the fixed title, then the matrix, who changed it and when, and the count', () => {
    const { blocks } = buildMatrixAuditMessage(SEP_29, SEP_29_ALERT_TIME, undefined)
    expect((blocks[0] as { text: { text: string } }).text.text).toBe('Bid matrix changed')
    expect(sectionTexts(blocks)[0]).toBe([
      '*Matrix:* AmOne Direct (regular, not sell-off)',
      '*Changed by:* Pat Example, 7:07 to 7:25 PM ET',
      '*Bids changed:* 7',
    ].join('\n'))
  })

  it('puts the grid in a code block and the Salesforce link last', () => {
    const { blocks } = buildMatrixAuditMessage(SEP_29, SEP_29_ALERT_TIME, 'https://x.lightning.force.com/lightning/n/Bid_Matrix')
    const texts = sectionTexts(blocks)
    expect(texts[1]).toBe('```\n' + formatGrid(SEP_29.cells)[0] + '\n```')
    expect(texts[texts.length - 1]).toBe('<https://x.lightning.force.com/lightning/n/Bid_Matrix|Open in Salesforce →>')
  })

  it('names a sell-off matrix as sell-off', () => {
    const { blocks } = buildMatrixAuditMessage({ ...SEP_29, is_sell_off: true }, SEP_29_ALERT_TIME, undefined)
    expect(sectionTexts(blocks)[0]).toContain('*Matrix:* AmOne Direct (sell-off)')
  })

  it('names two editors and a single moment plainly', () => {
    const { blocks } = buildMatrixAuditMessage(
      { ...SEP_29, editors: ['Pat Example', 'Sam Sample'], edited_from: '2026-09-29T23:25:06.000Z' },
      SEP_29_ALERT_TIME,
      undefined,
    )
    expect(sectionTexts(blocks)[0]).toContain('*Changed by:* Pat Example and Sam Sample, at 7:25 PM ET')
  })

  it('dates the edit when it was not made on the day the alert goes out', () => {
    const { blocks } = buildMatrixAuditMessage(SEP_29, new Date('2026-10-01T14:00:00.000Z'), undefined)
    expect(sectionTexts(blocks)[0]).toContain('*Changed by:* Pat Example, Sep 29, 7:07 to 7:25 PM ET')
  })

  it('dates both ends when an edit runs past midnight', () => {
    const { blocks } = buildMatrixAuditMessage(
      { ...SEP_29, edited_from: '2026-09-30T03:58:00.000Z', edited_to: '2026-09-30T04:03:00.000Z' },
      new Date('2026-09-30T05:00:00.000Z'),
      undefined,
    )
    expect(sectionTexts(blocks)[0]).toContain('*Changed by:* Pat Example, Sep 29, 11:58 PM to Sep 30, 12:03 AM ET')
  })

  // The span comes from the rows deleted since the last run. When those could
  // not be read, only the last save is known, so the line claims only that.
  it('claims only the last save when the earlier saves could not be read', () => {
    const { blocks } = buildMatrixAuditMessage({ ...SEP_29, earlier_saves_unread: true }, SEP_29_ALERT_TIME, undefined)
    expect(sectionTexts(blocks)[0]).toContain('*Changed by:* Pat Example, last saved at 7:25 PM ET')
  })

  it('says so when Salesforce did not record who made the edit', () => {
    const { blocks } = buildMatrixAuditMessage(
      { ...SEP_29, editors: [], edited_from: null, edited_to: null },
      SEP_29_ALERT_TIME,
      undefined,
    )
    expect(sectionTexts(blocks)[0]).toContain('*Changed by:* not recorded in Salesforce')
  })

  it('carries the facts in the notification text, which is all a phone shows', () => {
    const { text } = buildMatrixAuditMessage(SEP_29, SEP_29_ALERT_TIME, undefined)
    expect(text).toBe('Bid matrix changed: AmOne Direct, 7 bids, by Pat Example')
  })
})
