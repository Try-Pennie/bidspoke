/**
 * Issue #728. The login protection was untested while looking tested: the e2e
 * spec asserted that /workflows ends at /login, which still passes with
 * middleware.ts deleted, because the API client does a client-side redirect to
 * /login on any 401. That spec observes the union of three gates and cannot tell
 * them apart, and the indistinguishability IS the failure mode.
 *
 * The decision is now a pure function with one branch per outcome, each carrying
 * a distinct `x-bidspoke-gate` value. A positive signal on the ALLOW path is
 * what lets a probe tell "the gate ran and allowed" from "the gate never ran".
 */
import { describe, it, expect } from 'vitest'
import { classifyAllowlistRpc, decideGate, GATE_HEADER, type AllowlistLookup } from '../auth-gate'

const FOUND: AllowlistLookup = { status: 'found' }
const ABSENT: AllowlistLookup = { status: 'absent' }
const FAILED: AllowlistLookup = { status: 'error', message: 'fetch failed' }

const EMPLOYEE = 'dwright@trypennie.com'
const OUTSIDER = 'someone@gmail.com'

describe('decideGate: no session', () => {
  it('sends a signed-out visitor on a protected path to /login', () => {
    const d = decideGate({ pathname: '/workflows', email: null, allowlist: ABSENT })
    expect(d).toEqual({ action: 'redirect', pathname: '/login', search: null, gate: 'redirect-login' })
  })

  it('lets a signed-out visitor through on every public path', () => {
    for (const pathname of ['/login', '/auth/callback', '/access-denied', '/docs', '/docs/nodes/code.md', '/llms.txt']) {
      expect(decideGate({ pathname, email: null, allowlist: ABSENT }).action).toBe('allow')
    }
  })
})

describe('decideGate: signed in', () => {
  it('allows an allowlisted employee on a protected path', () => {
    const d = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FOUND })
    expect(d).toEqual({ action: 'allow', gate: 'allow' })
  })

  it('refuses a non-company domain, whatever the allowlist says', () => {
    const d = decideGate({ pathname: '/workflows', email: OUTSIDER, allowlist: FOUND })
    expect(d.action).toBe('redirect')
    expect(d).toMatchObject({ pathname: '/access-denied', gate: 'redirect-domain' })
  })

  it('refuses a company address that is not on the allowlist', () => {
    const d = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: ABSENT })
    expect(d).toMatchObject({ pathname: '/access-denied', gate: 'redirect-not-allowlisted' })
  })

  it('sends a signed-in user away from /login to the app', () => {
    const d = decideGate({ pathname: '/login', email: EMPLOYEE, allowlist: FOUND })
    expect(d).toMatchObject({ pathname: '/workflows', gate: 'redirect-signed-in' })
  })

  it('leaves a signed-in user alone on the other public paths', () => {
    expect(decideGate({ pathname: '/access-denied', email: EMPLOYEE, allowlist: FOUND }).action).toBe('allow')
    expect(decideGate({ pathname: '/docs', email: EMPLOYEE, allowlist: FOUND }).action).toBe('allow')
  })
})

// The branch that had no explicit handling at all: the allowlist read was
// destructured as `{ data: entry }` with the error dropped, so a failed lookup
// was indistinguishable from a genuine denial and sent a real employee to
// /access-denied with nothing saying why.
describe('decideGate: the allowlist lookup itself fails (#728)', () => {
  it('fails CLOSED rather than letting the request through', () => {
    const d = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FAILED })
    expect(d.action).toBe('redirect')
  })

  it('is distinguishable from a genuine denial, in the header and in the URL', () => {
    const denied = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: ABSENT })
    const broken = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FAILED })
    expect(broken.gate).toBe('gate-unavailable')
    expect(broken.gate).not.toBe(denied.gate)
    expect(broken).toMatchObject({ pathname: '/access-denied', search: 'reason=gate_unavailable' })
  })

  // /access-denied is public, so it is terminal: sending the failure there
  // cannot loop. Sending it to /login would loop, because /login is a public
  // path where the allowlist is never read, so the error state never recurs
  // there and the redirect would bounce forever.
  it('lands on a public, terminal page so it cannot loop', () => {
    const broken = decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FAILED })
    expect(broken.action).toBe('redirect')
    if (broken.action !== 'redirect') throw new Error('unreachable')
    const next = decideGate({ pathname: broken.pathname, email: EMPLOYEE, allowlist: FAILED })
    expect(next.action).toBe('allow')
  })

  it('still refuses a non-company domain before the lookup is even consulted', () => {
    const d = decideGate({ pathname: '/workflows', email: OUTSIDER, allowlist: FAILED })
    expect(d).toMatchObject({ gate: 'redirect-domain' })
  })
})

describe('decideGate: every outcome is separately identifiable', () => {
  it('uses a distinct gate value per outcome', () => {
    const gates = [
      decideGate({ pathname: '/workflows', email: null, allowlist: ABSENT }).gate,
      decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FOUND }).gate,
      decideGate({ pathname: '/workflows', email: OUTSIDER, allowlist: FOUND }).gate,
      decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: ABSENT }).gate,
      decideGate({ pathname: '/workflows', email: EMPLOYEE, allowlist: FAILED }).gate,
      decideGate({ pathname: '/login', email: EMPLOYEE, allowlist: FOUND }).gate,
    ]
    expect(new Set(gates).size).toBe(gates.length)
  })

  it('names the header once, so the middleware and the probe cannot disagree', () => {
    expect(GATE_HEADER).toBe('x-bidspoke-gate')
  })
})

// An empty or malformed email must not slip past the domain rule. Note
// `''.endsWith('@trypennie.com')` is false, so an empty address is refused, but
// the check has to be the shared one rather than a second inlined copy.
describe('decideGate: degenerate identities', () => {
  it.each(['', '   ', 'dwright@trypennie.com.evil.com', 'dwright@TRYPENNIE.COM.attacker.io', '@trypennie.com.x'])(
    'refuses %j on a protected path',
    (email) => {
      const d = decideGate({ pathname: '/workflows', email, allowlist: FOUND })
      expect(d.action).toBe('redirect')
    },
  )

  it('accepts the company domain case-insensitively', () => {
    const d = decideGate({ pathname: '/workflows', email: 'DWright@TryPennie.com', allowlist: FOUND })
    expect(d.action).toBe('allow')
  })
})

/**
 * Issue #729. The allowlist read moves off a direct table SELECT (governed by an
 * RLS policy of `USING (true)`, which let any authenticated Google account
 * enumerate every internal email) onto `is_allowlisted()`, a security-definer
 * function returning only a boolean.
 *
 * The classifier is the risky half of that move. Collapsing "the function said
 * no" into "the function did not answer" would reintroduce the swallowed-error
 * bug #728 exists to prevent, so the three states stay distinct here.
 */
describe('classifyAllowlistRpc (#729)', () => {
  it('reads a true answer as on the list', () => {
    expect(classifyAllowlistRpc({ data: true, error: null })).toEqual({ status: 'found' })
  })

  it('reads a false answer as a genuine refusal', () => {
    expect(classifyAllowlistRpc({ data: false, error: null })).toEqual({ status: 'absent' })
  })

  it('keeps a lookup failure distinct from a refusal', () => {
    const r = classifyAllowlistRpc({ data: null, error: { message: 'schema cache reload' } })
    expect(r.status).toBe('error')
    expect(r).toMatchObject({ message: 'schema cache reload' })
  })

  it('treats a missing answer as a failure, never as a refusal', () => {
    // `data: null` with no error means the function did not answer: a revoked
    // EXECUTE grant, a dropped function, a schema reload. Scoring that as
    // `absent` would send a real employee to /access-denied with nothing saying
    // why, which is precisely the indistinguishability #728 removed.
    expect(classifyAllowlistRpc({ data: null, error: null }).status).toBe('error')
  })

  it('refuses a non-boolean answer rather than guessing at its truthiness', () => {
    // PostgREST returns whatever the function returns. A shape change must not
    // be coerced into an allow.
    expect(classifyAllowlistRpc({ data: 'true', error: null }).status).toBe('error')
  })
})
