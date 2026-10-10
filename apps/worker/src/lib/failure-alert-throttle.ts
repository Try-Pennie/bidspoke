/**
 * Burst collapse for the default per-run failure alert (#693).
 *
 * fireExecutionAlert pages once per failed run with no dedup. A sustained
 * upstream failure (the 2026-07-21 ping_lendswift HTTP 500 flood on RML Bidding)
 * then posts one Slack message per failed lead and trains people to ignore the
 * channel. This throttles the Slack SEND so a burst of the same signal collapses
 * to one message per window. A single or low-rate failure still pages (the first
 * of each signal always posts), and a genuinely different failure pages on its
 * own (L707). The execution is still recorded as failed and its per-execution
 * snapshot is still written, so nothing is hidden from the dashboard, only from
 * the Slack burst.
 *
 * It uses the cooldown-set-after-success pattern from failure-rate.ts, NOT a
 * pre-claim: the cooldown is written only once a page has actually gone out, so a
 * failed or unconfigured Slack send never opens a silent window that swallows the
 * rest of the burst. The cost is that a tight concurrent burst can let a handful
 * through before the first success writes the cooldown, which is an acceptable
 * trade for never silencing a real failure (collapsing a flood to a few still
 * fixes the one-page-per-lead problem). Both reads and writes fail open: a KV
 * error means "not suppressed", so the throttle can never be the reason a real
 * failure goes unseen.
 */
import { normalizeErrorShape } from './upstream-outage'

// Long enough to collapse a burst, short enough that a sustained outage re-pages
// and stays visible rather than going silent after the first message.
export const FAILURE_ALERT_COOLDOWN_SECONDS = 15 * 60

type KvLike = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

// The signature, and the KV cooldown key built from it, stay under Workers KV's
// 512-byte key limit. The cap is in BYTES, not characters: a non-ASCII error (CJK,
// emoji, accented text) runs 3 to 4 bytes per character, so a character cap would
// still let the key exceed the byte limit, which KV rejects, which fails open and
// brings back the per-run spam for exactly the noisy errors this exists to
// collapse. The prefix is 23 bytes, so 450 leaves comfortable headroom. Two errors
// on the same workflow and step that share this much normalized text are the same
// burst, so capping them to one signature is correct, not a loss.
const MAX_SIGNATURE_BYTES = 450

// Truncate to a byte budget, staying at or under it. Slicing the UTF-8 bytes can
// cut a multibyte character; the default TextDecoder turns that trailing fragment
// into one U+FFFD (3 bytes), so we drop that replacement character, leaving only
// the characters that fully fit and a result that is <= maxBytes.
function capBytes(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  const decoded = new TextDecoder().decode(bytes.slice(0, maxBytes))
  return decoded.endsWith('�') ? decoded.slice(0, -1) : decoded
}

/**
 * The burst signature: same workflow, same failed step, same error shape (ids,
 * timestamps and sizes normalized out, so a per-lead flood shares one shape while
 * a 500 and a 403 stay apart). A different workflow, step or shape yields a
 * different signature and pages on its own.
 */
export function failureAlertSignature(
  workflowId: string,
  failedStep: string | undefined,
  errorMessage: string | undefined,
): string {
  return capBytes(`${workflowId}|${failedStep ?? ''}|${normalizeErrorShape(errorMessage)}`, MAX_SIGNATURE_BYTES)
}

const cooldownKey = (signature: string): string => `failure-alert-cooldown:${signature}`

/**
 * Whether a recent alert for this signature already went out, so this failure is
 * part of a burst and should be collapsed. Fails open (not suppressed) on a KV
 * error, so a read failure never silences the page.
 */
export async function failureAlertSuppressed(kv: KvLike, signature: string): Promise<boolean> {
  try {
    return (await kv.get(cooldownKey(signature))) !== null
  } catch (e) {
    console.error('[failure-alert-throttle] cooldown read failed, not suppressing:', e)
    return false
  }
}

/**
 * Open the collapse window for a signature. Called ONLY after a page has actually
 * gone out, so a failed send never starts a window that swallows the rest of the
 * burst. Best-effort: a KV write failure just means the next failure also pages.
 */
export async function markFailureAlertSent(
  kv: KvLike,
  signature: string,
  ttlSeconds: number = FAILURE_ALERT_COOLDOWN_SECONDS,
): Promise<void> {
  try {
    await kv.put(cooldownKey(signature), '1', { expirationTtl: ttlSeconds })
  } catch (e) {
    console.error('[failure-alert-throttle] cooldown write failed:', e)
  }
}
