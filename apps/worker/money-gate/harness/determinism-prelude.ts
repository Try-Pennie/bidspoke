/**
 * The clock and randomness pins for code bundles (#1704, L504).
 *
 * A code node that stamps the time or mints an id would differ between the merge
 * base run and the head run for no reason the pull request caused. The bundle is
 * hosted behind a tiny entry module that imports this prelude first, so the
 * script sees a fixed Date and a seeded Math.random, crypto.getRandomValues and
 * crypto.randomUUID, reseeded per dispatch from the fixture and dispatch order.
 */

export function determinismPrelude(fixedTimeMs: number): string {
  return `
const FIXED = ${fixedTimeMs}
const RealDate = Date
class GateDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(FIXED); else super(...args) }
  static now() { return FIXED }
}
globalThis.Date = GateDate

let state = 1
function next() {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
export function reseed(seed) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  state = h
}
Math.random = next
const getRandomValues = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * 256); return arr }
Object.defineProperty(crypto, 'getRandomValues', { value: getRandomValues, configurable: true, writable: true })
Object.defineProperty(crypto, 'randomUUID', {
  value: () => {
    const b = getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
  },
  configurable: true,
  writable: true,
})
`
}

export const GATE_ENTRY = `
import { reseed } from './gate-determinism.mjs'
import inner from './script.js'
export default {
  async fetch(request, env, ctx) {
    reseed(request.headers.get('x-money-gate-seed') || '')
    return inner.fetch(request, env, ctx)
  },
}
`
