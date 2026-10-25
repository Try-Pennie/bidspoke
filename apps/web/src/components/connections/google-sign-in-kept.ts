/**
 * What the add form or the Reconnect held when Sign in with Google left for
 * Google, kept across the round trip (#2338, build PR 13; Dan's decision D1 of
 * 2026-10-23: a sign in that did not go through lands back in the form he left,
 * everything he chose kept). Kept in the tab's session storage under the state
 * Google carries there and back, so a return finds the values its own start
 * kept, and taken once.
 *
 * Only what the form showed: the name typed, or which connection a Reconnect
 * was for. Never a login. Storage that is missing or refuses (a private window,
 * blocked site data) keeps nothing and throws nothing: the return then opens
 * the Google form with the own account chosen and the name empty.
 */

export type KeptSignIn = { kind: 'new'; name: string } | { kind: 'reconnect'; connectionId: string }

export interface KeptSignIns {
  keep(state: string, kept: KeptSignIn): void
  /** The values kept under this state, removed as they are read; null when there are none. */
  take(state: string): KeptSignIn | null
}

/** The part of Storage this reads. */
export interface KeptStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = 'bidspoke.google-sign-in.'

function readKept(raw: string | null): KeptSignIn | null {
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    if (r.kind === 'new' && typeof r.name === 'string') return { kind: 'new', name: r.name }
    if (r.kind === 'reconnect' && typeof r.connectionId === 'string') return { kind: 'reconnect', connectionId: r.connectionId }
    return null
  } catch {
    return null
  }
}

export function keptSignInsIn(storage: KeptStorage | null): KeptSignIns {
  return {
    keep: (state, kept) => {
      try {
        storage?.setItem(KEY + state, JSON.stringify(kept))
      } catch {
        // Nothing kept: the return opens the form with its own defaults.
      }
    },
    take: (state) => {
      try {
        const kept = readKept(storage?.getItem(KEY + state) ?? null)
        storage?.removeItem(KEY + state)
        return kept
      } catch {
        return null
      }
    },
  }
}

/** The tab's own session storage, or none where the browser refuses it. */
export function sessionKeptSignIns(): KeptSignIns {
  let storage: KeptStorage | null = null
  try {
    storage = typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    storage = null
  }
  return keptSignInsIn(storage)
}
