import { describe, expect, it } from 'vitest'
import { parseArgs } from './args.ts'

describe('parseArgs', () => {
  it('refuses to create anything without --i-have-approval (decision 1)', () => {
    const parsed = parseArgs(['--ledger', '/tmp/l.json'])
    expect(parsed.mode).toBe('refuse')
    if (parsed.mode === 'refuse') expect(parsed.message).toMatch(/--i-have-approval/)
  })

  it('refuses a creating run with no ledger path', () => {
    const parsed = parseArgs(['--i-have-approval'])
    expect(parsed.mode).toBe('refuse')
    if (parsed.mode === 'refuse') expect(parsed.message).toMatch(/--ledger/)
  })

  it('runs with approval and a ledger, 20 samples by default', () => {
    expect(parseArgs(['--i-have-approval', '--ledger', '/tmp/l.json'])).toEqual({
      mode: 'run',
      ledgerPath: '/tmp/l.json',
      samples: 20,
      selfInterrupt: false,
    })
  })

  it('takes --samples and --self-interrupt', () => {
    expect(parseArgs(['--i-have-approval', '--ledger', 'l.json', '--samples', '5', '--self-interrupt'])).toEqual({
      mode: 'run',
      ledgerPath: 'l.json',
      samples: 5,
      selfInterrupt: true,
    })
  })

  it('refuses a sample count that is not a positive whole number', () => {
    expect(parseArgs(['--i-have-approval', '--ledger', 'l.json', '--samples', '0']).mode).toBe('refuse')
    expect(parseArgs(['--i-have-approval', '--ledger', 'l.json', '--samples', 'x']).mode).toBe('refuse')
  })

  it('cleans up from a ledger without approval, because it only removes what the ledger names', () => {
    expect(parseArgs(['--cleanup', '/tmp/l.json'])).toEqual({ mode: 'cleanup', ledgerPath: '/tmp/l.json' })
  })

  it('refuses a flag where a path or number belongs, rather than swallowing it as the value', () => {
    const swallowed = parseArgs(['--ledger', '--i-have-approval'])
    expect(swallowed.mode).toBe('refuse')
    if (swallowed.mode === 'refuse') expect(swallowed.message).toMatch(/--ledger needs a value/)
    expect(parseArgs(['--cleanup', '--samples']).mode).toBe('refuse')
    expect(parseArgs(['--i-have-approval', '--ledger']).mode).toBe('refuse')
  })

  it('refuses an unknown flag rather than ignoring it', () => {
    const parsed = parseArgs(['--i-have-approval', '--ledger', 'l.json', '--sampels', '5'])
    expect(parsed.mode).toBe('refuse')
    if (parsed.mode === 'refuse') expect(parsed.message).toMatch(/--sampels/)
  })
})
