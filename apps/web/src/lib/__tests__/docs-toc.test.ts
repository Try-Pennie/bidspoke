import { describe, it, expect } from 'vitest'
import { extractHeadings, slugifyHeading, stripInlineMarkdown } from '../docs-toc'

describe('slugifyHeading', () => {
  it('lowercases, dashes spaces, drops punctuation (GitHub style)', () => {
    expect(slugifyHeading('On this page')).toBe('on-this-page')
    expect(slugifyHeading('Coalesce: `??`')).toBe('coalesce-')
    expect(slugifyHeading('Arithmetic: `* / + -`')).toBe('arithmetic--')
    expect(slugifyHeading('GET /api/workflows/:id')).toBe('get-apiworkflowsid')
  })

  it('strips inline code and link markup before slugging', () => {
    expect(slugifyHeading('The `timeout_ms` field')).toBe('the-timeout_ms-field')
    expect(slugifyHeading('[Linked](./x.md) heading')).toBe('linked-heading')
  })
})

describe('stripInlineMarkdown', () => {
  it('removes code ticks, link targets, and emphasis markers', () => {
    expect(stripInlineMarkdown('`code` and *bold* and [text](url)')).toBe('code and bold and text')
    expect(stripInlineMarkdown('keeps `timeout_ms` underscores')).toBe('keeps timeout_ms underscores')
  })
})

describe('extractHeadings', () => {
  it('extracts h2 and h3 with levels, skipping h1 and h4+', () => {
    const md = ['# Title', '## Section A', 'body', '### Sub A1', '#### Deep', '## Section B'].join('\n')
    expect(extractHeadings(md)).toEqual([
      { level: 2, text: 'Section A', id: 'section-a' },
      { level: 3, text: 'Sub A1', id: 'sub-a1' },
      { level: 2, text: 'Section B', id: 'section-b' },
    ])
  })

  it('ignores ## lines inside fenced code blocks', () => {
    const md = ['## Real', '```bash', '## not a heading', '```', '~~~', '### also not', '~~~', '### Real Sub'].join('\n')
    expect(extractHeadings(md).map((h) => h.text)).toEqual(['Real', 'Real Sub'])
  })

  it('strips inline markdown from heading text for the rail label', () => {
    const md = '## The `bid_group` node'
    expect(extractHeadings(md)[0]).toEqual({ level: 2, text: 'The bid_group node', id: 'the-bid_group-node' })
  })

  it('returns empty for heading-free markdown', () => {
    expect(extractHeadings('just text\nmore text')).toEqual([])
  })
})
