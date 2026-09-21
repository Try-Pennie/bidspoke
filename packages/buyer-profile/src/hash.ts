/** FNV-1a over UTF-16 code units, 32 bit. Deterministic, dependency free, spreads evenly. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 0 to 99. The live share admits a lead when its bucket is below the percent in force. */
export function canaryBucket(leadKey: string): number {
  return fnv1a32(leadKey) % 100
}
