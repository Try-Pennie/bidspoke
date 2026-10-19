/**
 * Seconds settings read by the CI scripts (#2335): one checked reader, and no
 * script reading a number from the environment without it (L50, L30).
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { secondsSetting } from '../../../../../.github/scripts/seconds-setting.mjs'

const SCRIPTS = path.resolve(__dirname, '../../../../../.github/scripts')

/** A number read straight from the environment, bypassing secondsSetting. */
export function bareEnvNumbers(source: string): string[] {
  return [...source.matchAll(/Number\(\s*(?:process\.)?env\.[A-Z_]+/g)].map((m) => m[0])
}

describe('secondsSetting', () => {
  it('uses the default when the setting is absent', () => {
    expect(secondsSetting(undefined, 120, 'BUDGET_SECONDS')).toBe(120)
  })

  it('reads a positive number of seconds', () => {
    expect(secondsSetting('45', 120, 'BUDGET_SECONDS')).toBe(45)
  })

  it.each(['', '  ', 'abc', '0', '-5', 'Infinity', 'NaN'])('refuses %j by name rather than using it', (raw) => {
    expect(() => secondsSetting(raw, 120, 'INTERVAL_SECONDS')).toThrow(/INTERVAL_SECONDS/)
  })
})

describe('no CI script reads a number from the environment unchecked', () => {
  const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'))

  it('scans the scripts, so it cannot pass by reading nothing (L98)', () => {
    expect(scripts).toEqual(expect.arrayContaining(['ops-connections-probe.mjs', 'partners-page-commit.mjs']))
  })

  it('finds no bare Number(env.X) in any script', () => {
    const offenders = scripts.flatMap((f) => bareEnvNumbers(readFileSync(path.join(SCRIPTS, f), 'utf8')).map((hit) => `${f}: ${hit}`))
    expect(offenders).toEqual([])
  })

  it('catches a planted bare read (seen red)', () => {
    expect(bareEnvNumbers("budgetSeconds: Number(env.BUDGET_SECONDS ?? '180'),")).toHaveLength(1)
    expect(bareEnvNumbers("const n = Number( process.env.INTERVAL_SECONDS )")).toHaveLength(1)
    expect(bareEnvNumbers("secondsSetting(env.BUDGET_SECONDS, 180, 'BUDGET_SECONDS')")).toEqual([])
  })
})
