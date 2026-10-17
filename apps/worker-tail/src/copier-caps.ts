/**
 * How many refused rows each tail worker record holds in its isolate before it
 * drops the oldest (#2166, #2284). A leaf with no runtime types, so the web
 * guard apps/web/src/lib/__tests__/tail-copier-caps.test.ts can hold
 * these against the crons in apps/worker/wrangler.toml.
 *
 * Each record has its own cap, sized from its own daily volume, so a database
 * outage of a day costs neither record a row.
 */

/**
 * Scheduled deliveries a day of the bidding Worker's nine crons, once each:
 * 1,440 of the minute tick, 288 every 5 minutes, 96 every 15, 24 hourly on the
 * hour, 24 hourly at :23, 12 every two hours at :37, and 3 daily.
 */
export const SCHEDULED_DELIVERIES_PER_DAY = 1_887

/**
 * The delivery record gets a row per delivery, twice as many while Cloudflare
 * doubles every tick (as it did from 2026-10-08). Two days of that: a day long
 * database outage drops nothing, with a day to spare.
 */
export const DELIVERY_HELD_CAP = 8_000

/**
 * The fail-open record gets a row per fail-open, and every delivery failing open
 * for a whole day is 1,887 (the measured rate is about 4 a day).
 */
export const FAIL_OPEN_HELD_CAP = 2_000
