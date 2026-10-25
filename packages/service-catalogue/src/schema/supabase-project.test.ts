import { describe, expect, it } from 'vitest'
import { supabaseProjectHost, supabaseProjectRefOf } from './supabase-project'

/**
 * The project a Supabase connection declares (#2337): read from what a person
 * copies from Supabase (the Project URL), or the bare project ref, and nothing
 * else, so a connection always names one project by its ref.
 */
describe('supabaseProjectRefOf', () => {
  it('reads the ref from the Project URL, with or without a path, or takes a bare ref', () => {
    expect(supabaseProjectRefOf('https://blicjwldjfjubbukxatn.supabase.co')).toBe('blicjwldjfjubbukxatn')
    expect(supabaseProjectRefOf(' https://BLICJWLDJFJUBBUKXATN.supabase.co/rest/v1/ ')).toBe('blicjwldjfjubbukxatn')
    expect(supabaseProjectRefOf('blicjwldjfjubbukxatn')).toBe('blicjwldjfjubbukxatn')
  })

  it('refuses anything that does not name exactly one project', () => {
    for (const value of [
      '', 'short', 'blicjwldjfjubbukxatn1', 'http://blicjwldjfjubbukxatn.supabase.co', 'https://db.blicjwldjfjubbukxatn.supabase.co',
      'https://blicjwldjfjubbukxatn.supabase.co.evil.example', 'https://blicjwldjfjubbukxatn.supabase.co:8443', 'https://u:p@blicjwldjfjubbukxatn.supabase.co',
      'https://blicjwldjfjubbukxatn.example.com', 'blicjwldjfjubbukxat!', 7, null, undefined,
    ]) {
      expect(supabaseProjectRefOf(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('names the project\'s one API host', () => {
    expect(supabaseProjectHost('blicjwldjfjubbukxatn')).toBe('blicjwldjfjubbukxatn.supabase.co')
  })
})
