import { describe, it, expect } from 'vitest'
import { findPayloadPrints } from '../payload-print-scan'

// #1230. Every fixture below is a real line from a live workflow definition,
// read on 2026-09-09. The MUST NOT FLAG cases matter as much as the others: a
// shape rule has to be proved against the content it must preserve, or the
// over-match reads exactly like the feature working (L104).

// The real shape, read from a live definition in `bidspoke-workflows` on
// 2026-09-09: `type` and `namespace` are flat on the node, and the code lives at
// `config.script`, not `config.code`. The first version of this file invented
// `data.config.code`, every test passed, and the scan found ZERO of the fourteen
// known sites in production (L48, L143).
function defWith(script: string, namespace = 'pennie_or_eligibility') {
  return { nodes: [{ id: 'n1', namespace, type: 'code', config: { script } }] }
}

describe('findPayloadPrints', () => {
  describe('flags a whole object being printed', () => {
    it('catches a bare identifier passed to JSON.stringify', () => {
      const f = findPayloadPrints(
        defWith('console.log(`Sending body to Eligibility Scout: ${JSON.stringify(parsedBody)}`);'),
      )
      expect(f).toHaveLength(1)
      expect(f[0].identifier).toBe('parsedBody')
    })

    it('catches one named sanitizedBody, because the name describes forwarding rather than redaction', () => {
      const f = findPayloadPrints(
        defWith('console.log(`Sending body to Engine: ${JSON.stringify(sanitizedBody)}`);'),
      )
      expect(f).toHaveLength(1)
    })

    it('catches a member expression, so wrapping the payload one level down is not a way past it', () => {
      const f = findPayloadPrints(defWith('console.log(JSON.stringify(props.body));'))
      expect(f).toHaveLength(1)
    })

    it('catches console.error and console.warn, not only console.log', () => {
      expect(findPayloadPrints(defWith('console.error(JSON.stringify(payload));'))).toHaveLength(1)
      expect(findPayloadPrints(defWith('console.warn(JSON.stringify(payload));'))).toHaveLength(1)
    })

    it('reports where it found each one', () => {
      const f = findPayloadPrints(defWith('console.log(JSON.stringify(result));', 'scout_call'))
      expect(f[0].namespace).toBe('scout_call')
    })
  })

  describe('does NOT flag', () => {
    it('a payload wrapped in a redaction helper', () => {
      expect(
        findPayloadPrints(
          defWith('console.log(`Sending: ${JSON.stringify(redactForLog(parsedBody))}`);'),
        ),
      ).toEqual([])
    })

    it('an object literal naming its own fields', () => {
      expect(
        findPayloadPrints(
          defWith("console.log('[engine-proxy]', JSON.stringify({ status: res.status, ok: res.ok }));"),
        ),
      ).toEqual([])
    })

    it('a plain string with no stringify at all', () => {
      expect(findPayloadPrints(defWith("console.log('Scout responded 200');"))).toEqual([])
    })

    it('a JSON.stringify that is not being logged', () => {
      expect(findPayloadPrints(defWith('const body = JSON.stringify(payload);'))).toEqual([])
    })

    it('a commented out line', () => {
      expect(findPayloadPrints(defWith('// console.log(JSON.stringify(payload));'))).toEqual([])
    })

    it('a node that is not a code node', () => {
      const def = {
        nodes: [
          { id: 'n1', namespace: 'x', type: 'filter', config: { script: 'console.log(JSON.stringify(payload));' } },
        ],
      }
      expect(findPayloadPrints(def)).toEqual([])
    })
  })

  it('finds every site in a node rather than stopping at the first', () => {
    const f = findPayloadPrints(
      defWith(
        'console.log(JSON.stringify(a));\nconsole.log("safe");\nconsole.log(JSON.stringify(b));',
      ),
    )
    expect(f.map((x) => x.identifier)).toEqual(['a', 'b'])
  })

  it('returns nothing for a definition with no nodes rather than throwing', () => {
    expect(findPayloadPrints({})).toEqual([])
    expect(findPayloadPrints({ nodes: [] })).toEqual([])
  })

  // Pins the field name the live definitions actually use, so a scan reading a
  // field that does not exist cannot pass by finding nothing (L98).
  it('reads the script from config.script, which is where live definitions keep it', () => {
    const f = findPayloadPrints({
      nodes: [{ id: 'n1', namespace: 'scout', type: 'code', config: { script: 'console.log(JSON.stringify(parsedBody));' } }],
    })
    expect(f).toHaveLength(1)
  })
})
