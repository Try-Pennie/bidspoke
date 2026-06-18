import { describe, it, expect } from 'vitest'
import { isPublicPath } from '../public-paths'

describe('isPublicPath', () => {
  it('treats the auth/public routes as public', () => {
    for (const p of ['/login', '/auth/callback', '/access-denied', '/mockup', '/docs', '/docs/nodes/code.md', '/llms.txt']) {
      expect(isPublicPath(p)).toBe(true)
    }
  })

  it('treats the /dev preview gallery as public (#227)', () => {
    expect(isPublicPath('/dev/nodes')).toBe(true)
    expect(isPublicPath('/dev')).toBe(true)
  })

  it('keeps the app routes protected', () => {
    for (const p of ['/', '/workflows', '/workflows/abc', '/dashboard', '/partners', '/settings/api-keys', '/env']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
})
