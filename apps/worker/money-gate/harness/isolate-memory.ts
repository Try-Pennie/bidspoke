/**
 * Forgets the module state lib/isolate-memory.ts lists, in the engine under
 * test, before every run of the outage drill (#1305, plan B1 on #1675). The
 * Record type requires a function for every listed state.
 */
import { forgetPartnerConstantsMemory } from '@money-gate-engine/lib/partner-constants-loader'
import { forgetPartnerLastGoodMemory } from '@money-gate-engine/lib/partner-last-good'
import { forgetStoredCopyLedger } from '@money-gate-engine/lib/stored-copy-ledger'
import type { ForgottenState } from '../lib/isolate-memory'

const FORGET: Record<ForgottenState, () => void> = {
  'src/lib/partner-constants-loader.ts:inflight': forgetPartnerConstantsMemory,
  'src/lib/partner-constants-loader.ts:memoryCache': forgetPartnerConstantsMemory,
  'src/lib/partner-last-good.ts:lastGoodWritten': forgetPartnerLastGoodMemory,
  'src/lib/stored-copy-ledger.ts:flushing': forgetStoredCopyLedger,
  'src/lib/stored-copy-ledger.ts:isolateId': forgetStoredCopyLedger,
  'src/lib/stored-copy-ledger.ts:lastFlushAt': forgetStoredCopyLedger,
  'src/lib/stored-copy-ledger.ts:pending': forgetStoredCopyLedger,
}

export function forgetIsolateMemory(): void {
  for (const forget of new Set(Object.values(FORGET))) forget()
}
