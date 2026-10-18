/**
 * @bidspoke/connection-seal (#2333, phase 3 of #1689): seals ops connection
 * logins to the ops public key on the bidding Worker, and opens them with the
 * ops private key on the ops Worker. See seal.ts for the design.
 */
export { RESTORE_DRILL_CANARY, restoreDrillAad } from './canary'
export { canonicalAad, canonicalJson, KID_PATTERN, type ConnectionAad } from './canonical-json'
export { SealError, type SealErrorCode } from './errors'
export { importPrivateKey, importPublicKey, MIN_MODULUS_BITS } from './key-import'
export { CURRENT_OPS_KID, OPS_CONNECTION_PUBLIC_KEYS } from './keys'
export { checkPrivateKeyOpens, open, seal, type KeyRing, type SealedEnvelope } from './seal'
