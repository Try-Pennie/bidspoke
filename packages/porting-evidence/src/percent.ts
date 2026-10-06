/**
 * Percent decoding for the porting redaction (#1816), and the merge that puts
 * values found in decoded text back onto the text as written.
 *
 * The recorder stores Pipedream's `steps.trigger.event`, whose `url` carries the
 * inbound query raw, so a key can arrive as `lead%5Bssn%5D=` or
 * `date%20of%20birth=`, and a whole nested address as `next=...%3Fssn%3D...`,
 * which holds no `=` at all until it is decoded.
 *
 * Each layer turns `+` into a space and every `%XX` naming an ASCII character
 * into that character, in one pass. A `%XX` naming a byte of a multibyte
 * character is left as written, and so is a `%` not followed by two hex
 * digits: every key and value shape the keyed pass looks for is ASCII, so
 * nothing it needs is lost, and nothing here can throw on malformed input the
 * way decodeURIComponent does (`%E0%A4%A`).
 *
 * A layer also records, for each character it produces, where that character
 * begins in the text it decoded, so a value found in the decoded view is
 * replaced in the ORIGINAL text and the rest of the address keeps its encoding
 * byte for byte.
 *
 * Layers are decoded until the text stops changing, up to MAX_DECODE_LEVELS.
 * The bound keeps the work linear: a crafted `%252525...` changes on every
 * layer, and an unbounded loop over it would be quadratic. Real addresses are
 * encoded once or twice; a value hidden under more than eight layers is kept.
 *
 * Not exported from the package entry: redact.ts is its only consumer.
 */

export const MAX_DECODE_LEVELS = 8
const PLUS = 43
const PERCENT = 37
/** How many code units go to one String.fromCharCode call, which takes a bounded number of arguments. */
const CHUNK = 8192

const hexValue = (c: number) =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1

/** The ASCII character a `%XX` at `i` names, or -1 when there is none to decode. */
function asciiEscapeAt(s: string, i: number): number {
  if (s.charCodeAt(i) !== PERCENT || i + 2 >= s.length) return -1
  const high = hexValue(s.charCodeAt(i + 1))
  const low = hexValue(s.charCodeAt(i + 2))
  return high < 0 || low < 0 || high > 7 ? -1 : high * 16 + low
}

/**
 * One decoded layer: its text, and `map`, where map[i] is the index in the
 * decoded source at which the layer's character i begins. map[text.length] is
 * the source's length, so a span [a, b) of the layer is [map[a], map[b]) of the
 * source.
 */
export interface DecodedLayer { text: string; map: Int32Array }

/** One layer of decoding, or null when the text holds nothing to decode. */
export function decodeLayer(s: string): DecodedLayer | null {
  let changed = false
  for (let i = 0; i < s.length && !changed; i++) changed = s.charCodeAt(i) === PLUS || asciiEscapeAt(s, i) !== -1
  if (!changed) return null
  const codes = new Uint16Array(s.length)
  const map = new Int32Array(s.length + 1)
  let n = 0
  for (let i = 0; i < s.length; i++) {
    map[n] = i
    const c = s.charCodeAt(i)
    const escaped = asciiEscapeAt(s, i)
    if (escaped !== -1) {
      codes[n++] = escaped
      i += 2
    } else {
      codes[n++] = c === PLUS ? 32 : c
    }
  }
  map[n] = s.length
  let text = ''
  for (let at = 0; at < n; at += CHUNK) {
    text += String.fromCharCode.apply(null, codes.subarray(at, Math.min(n, at + CHUNK)) as unknown as number[])
  }
  return { text, map: map.subarray(0, n + 1) }
}

/** The text with every layer of encoding removed, up to the bound. */
export function decodeFully(s: string): string {
  let text = s
  for (let level = 0; level < MAX_DECODE_LEVELS; level++) {
    const layer = decodeLayer(text)
    if (layer === null) break
    text = layer.text
  }
  return text
}

/** One span of text to replace: [start, end) becomes the replacement. */
export interface Splice { start: number; end: number; text: string }

/** A splice found in one decoded layer, carrying that layer's depth (0 is the text as written). */
export interface LayeredSplice extends Splice { level: number }

/** A merged splice. `rehash` marks one joined from spans that only partly overlapped, whose text must be computed afresh. */
export interface MergedSplice extends Splice { rehash: boolean }

/**
 * Splices found across layers, all placed on the text as written, merged so
 * none overlap, in order. Where layers found the same span the deepest wins:
 * its replacement hashes the decoded value, so `123%2D45%2D6789` scrambles
 * exactly as `123-45-6789` does. A span inside another is dropped, since the
 * outer replacement covers it. Two spans that only partly overlap become one,
 * marked for a fresh replacement, because neither text covers the union.
 */
export function mergeLayeredSplices(found: LayeredSplice[]): MergedSplice[] {
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end || b.level - a.level)
  const merged: MergedSplice[] = []
  for (const sp of sorted) {
    const last = merged[merged.length - 1]
    if (last === undefined || sp.start >= last.end) {
      merged.push({ start: sp.start, end: sp.end, text: sp.text, rehash: false })
      continue
    }
    if (sp.end <= last.end) continue
    last.end = sp.end
    last.rehash = true
  }
  return merged
}
