import { describe, it, expect } from 'vitest'
// The CI docs-integrity gate. The pure check is exported so the link rules are
// pinned by tests — a regression here means broken links ship silently again.
import { collectDocErrors, isRelativeDocLink } from '../../../scripts/check-docs.mjs'

function pages(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries))
}

describe('isRelativeDocLink', () => {
  it('accepts relative paths and rejects external/anchor/absolute targets', () => {
    expect(isRelativeDocLink('./other.md')).toBe(true)
    expect(isRelativeDocLink('../guides/x.md')).toBe(true)
    expect(isRelativeDocLink('plain.md')).toBe(true)
    expect(isRelativeDocLink('https://example.com/x.md')).toBe(false)
    expect(isRelativeDocLink('mailto:dan@trypennie.com')).toBe(false)
    expect(isRelativeDocLink('#section')).toBe(false)
    expect(isRelativeDocLink('/docs/abs.md')).toBe(false)
  })
})

describe('collectDocErrors', () => {
  it('passes when every relative link resolves to a published page', () => {
    const errs = collectDocErrors(
      pages({
        'README.md': '[overview](concepts/overview.md)',
        'concepts/overview.md': '[back](../README.md) and [guide](../guides/g.md#section)',
        'guides/g.md': 'no links',
      }),
      ''
    )
    expect(errs).toEqual([])
  })

  it('flags a link to a missing page', () => {
    const errs = collectDocErrors(pages({ 'concepts/a.md': '[dead](./nope.md)' }), '')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('concepts/a.md')
    expect(errs[0]).toContain('./nope.md')
  })

  it('flags a link that resolves outside the docs tree (except ../llms.txt from the root)', () => {
    const errs = collectDocErrors(
      pages({
        'README.md': '[ok](../llms.txt)',
        'concepts/a.md': '[escape](../../secrets.md)',
      }),
      ''
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('escapes the docs tree')
  })

  it('ignores external links and in-page anchors', () => {
    const errs = collectDocErrors(
      pages({ 'concepts/a.md': '[x](https://example.com/dead.md) [y](#anchor) [z](mailto:a@b.c)' }),
      ''
    )
    expect(errs).toEqual([])
  })

  it('strips anchors before resolving (page#section)', () => {
    const ok = collectDocErrors(
      pages({ 'concepts/a.md': '[x](./b.md#deep-section)', 'concepts/b.md': '' }),
      ''
    )
    expect(ok).toEqual([])
    const bad = collectDocErrors(pages({ 'concepts/a.md': '[x](./gone.md#deep)' }), '')
    expect(bad).toHaveLength(1)
  })

  it('checks non-md asset links via assetExists', () => {
    const md = pages({ 'concepts/a.md': '[img](./diagram.png)' })
    expect(collectDocErrors(md, '', () => true)).toEqual([])
    expect(collectDocErrors(md, '', () => false)).toHaveLength(1)
  })

  it('flags llms.txt entries that point at unpublished pages', () => {
    const errs = collectDocErrors(
      pages({ 'guides/real.md': '' }),
      [
        '- [Real](https://bidspoke.trypennie.dev/docs/guides/real.md): fine.',
        '- [Gone](https://bidspoke.trypennie.dev/docs/guides/deleted-guide.md): stale.',
      ].join('\n')
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('guides/deleted-guide.md')
  })
})
