/**
 * Every refusal the seal makes, by name (#2333).
 *
 * A caller decides what to tell a person, or which page to raise, from the
 * code alone, so each cause has its own (L11). No message ever carries key
 * material, a plaintext or a ciphertext: only kids, field names and sizes.
 */
export type SealErrorCode =
  /** A value the canonical JSON encoder has no single form for. */
  | 'seal_canonical_invalid'
  /** The binding is missing a field, has an extra one, or a field is the wrong shape. */
  | 'seal_aad_invalid'
  /** The plaintext is not a string UTF-8 can carry unchanged. */
  | 'seal_plaintext_invalid'
  /** The ring holds no key under the kid asked for. */
  | 'seal_unknown_kid'
  /** The envelope was sealed under one kid and the caller asked to open it as another. */
  | 'seal_kid_mismatch'
  /** The envelope is not the shape this version writes. */
  | 'seal_envelope_malformed'
  /** The envelope names a version this code does not open. */
  | 'seal_envelope_version'
  /** RSA-OAEP refused the wrapped key: the wrong private key, a tampered wrapped key, or a different binding. */
  | 'seal_unwrap_failed'
  /** AES-GCM refused the ciphertext: tampered ciphertext, iv or tag, a swapped wrapped key, or a different binding. */
  | 'seal_decrypt_failed'
  /** The key text is not a single PEM block of a form Web Crypto can import. */
  | 'seal_key_malformed'
  /** A private key offered where a public one belongs, or the reverse. */
  | 'seal_key_wrong_kind'
  /** A real key, of a family other than RSA. */
  | 'seal_key_not_rsa'
  /** An RSA key below MIN_MODULUS_BITS. */
  | 'seal_key_too_small'

export class SealError extends Error {
  readonly code: SealErrorCode

  constructor(code: SealErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'SealError'
    this.code = code
  }
}
