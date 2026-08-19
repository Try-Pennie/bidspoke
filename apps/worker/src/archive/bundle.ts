// Per-execution archive bundle: one execution row plus its step rows, compressed
// to a single wire string. Phase A0 measures it; Phase A3 ships it.
//
// One row per execution, not one per step, is what takes archive ingest from
// ~1.15M rows/day to ~105k/day, below the volume the existing sightings export
// already clears in production.

export interface Bundle {
  execution: unknown
  steps: unknown[]
}

export interface EncodedBundle {
  /** base64 of the gzipped JSON: what actually goes over the wire. */
  wire: string
  /** Bytes of the JSON before compression. */
  rawBytes: number
  /** Bytes after gzip, before base64. */
  gzipBytes: number
  /** Bytes actually sent, which is what the statement ceiling is measured in. */
  wireBytes: number
  /**
   * Steps present in the ENCODED bundle, read back out of `wire` rather than
   * taken from the caller. The deletion gate compares this against an
   * independent Postgres count, so a count sourced from the caller's intent
   * would let both sides agree while every bundle was short (L63).
   */
  stepCount: number
  /**
   * CPU spent per stage. Cadence and batch size are decided by CPU against the
   * Workers ceiling, not by bytes, so the stages are timed separately.
   * `verify` is the cost of reading the bundle back to derive `stepCount`.
   */
  cpuMs: { stringify: number; gzip: number; base64: number; verify: number }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function through(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export async function encodeBundle(bundle: Bundle): Promise<EncodedBundle> {
  const t0 = performance.now()
  const json = JSON.stringify(bundle)
  const raw = new TextEncoder().encode(json)

  const t1 = performance.now()
  const gz = await through(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')))

  const t2 = performance.now()
  const wire = toBase64(gz)

  // Read the count back out of what was actually produced, so a compression or
  // truncation fault is caught here rather than by a gate that trusts it.
  const t3 = performance.now()
  const stepCount = (await decodeBundle(wire)).steps.length
  const t4 = performance.now()

  return {
    wire,
    rawBytes: raw.length,
    gzipBytes: gz.length,
    wireBytes: wire.length,
    stepCount,
    cpuMs: { stringify: t1 - t0, gzip: t2 - t1, base64: t3 - t2, verify: t4 - t3 },
  }
}

export async function decodeBundle(wire: string): Promise<Bundle> {
  const gz = fromBase64(wire)
  const raw = await through(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')))
  return JSON.parse(new TextDecoder().decode(raw)) as Bundle
}
