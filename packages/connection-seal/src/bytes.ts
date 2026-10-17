/** Byte helpers for the seal (#2333), with strict decoding: a lax decoder accepts what this code never writes. */

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
  return btoa(binary)
}

/** Decodes standard padded base64, or returns null for anything else. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!STRICT_BASE64.test(text)) return null
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** True when UTF-8 carries the string unchanged, which a lone surrogate does not. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}
