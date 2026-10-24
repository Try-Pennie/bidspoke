/**
 * Each service's own mark on the App Action card (#2339): every catalogue
 * service has one, or is listed as markless with the reason, and every mark
 * says where it came from.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './catalogue'
import { catalogueActions } from './lookup'
import { GOOGLE_PRODUCT_MARKS, MARKLESS, SERVICE_MARKS, SIMPLE_ICONS_VERSION, markKeyFor } from './marks'

describe('service marks', () => {
  it('every catalogue service has a mark, Google one per product, or is markless with its reason', () => {
    for (const s of CATALOGUE) {
      if (s.key === 'google') continue
      const marked = Object.hasOwn(SERVICE_MARKS, s.key)
      expect(marked || Object.hasOwn(MARKLESS, s.key), s.key).toBe(true)
      expect(marked && Object.hasOwn(MARKLESS, s.key), `${s.key} is both marked and markless`).toBe(false)
    }
    for (const action of catalogueActions(CATALOGUE).filter((a) => a.key.startsWith('google.'))) {
      const key = markKeyFor('google', action.key)
      expect(key, action.key).not.toBeNull()
      expect(Object.hasOwn(SERVICE_MARKS, key as string), action.key).toBe(true)
    }
  })

  it('lists as markless only catalogue services, each with a reason', () => {
    const keys = new Set(CATALOGUE.map((s) => s.key))
    for (const [key, why] of Object.entries(MARKLESS)) {
      expect(keys.has(key), key).toBe(true)
      expect(why.trim().length).toBeGreaterThan(0)
    }
  })

  it('every mark records its source at an exact version, and draws at least one path with a colour', () => {
    for (const [key, mark] of Object.entries(SERVICE_MARKS)) {
      expect(mark.source, key).toMatch(/Simple Icons \d+\.\d+\.\d+ \(CC0 1\.0\)|lucide-react \d+\.\d+\.\d+ \(ISC\)|settled card design/)
      expect(mark.paths.length, key).toBeGreaterThan(0)
      for (const p of mark.paths) expect(p.fill ?? p.stroke, key).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
    expect(SIMPLE_ICONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('HTTP and Supabase have marks ready for their services', () => {
    expect(SERVICE_MARKS.http?.title).toBe('HTTP')
    expect(SERVICE_MARKS.supabase?.title).toBe('Supabase')
  })

  it('names a Google step by its product\'s mark, any other by its service\'s, and nothing for a markless service', () => {
    expect(markKeyFor('google', 'google.gmail-send-email')).toBe('google.gmail')
    expect(markKeyFor('anthropic', 'anthropic.chat')).toBe('anthropic')
    expect(markKeyFor('slack', 'slack.send-message')).toBeNull()
    expect(markKeyFor('google', null)).toBeNull()
    expect(Object.keys(GOOGLE_PRODUCT_MARKS)).toHaveLength(4)
  })
})
