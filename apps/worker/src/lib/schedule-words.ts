/**
 * A cron schedule in words a non engineer reads (#1300).
 *
 * Alerts used to print `23 * * * *` where the reader needs "every hour at :23".
 * Only the shapes the worker actually runs on are read; anything else answers
 * null, so a caller says "the next scheduled run" rather than a wrong time.
 * A daily time is given in Eastern time, which is how Dan reads every time.
 */

const NUMBER = /^\d+$/
const EVERY = /^\*\/(\d+)$/

/** A field as a whole number inside [0, max], or null: out of range must never read as a time. */
function inRange(field: string, max: number): number | null {
  if (!NUMBER.test(field)) return null
  const n = Number(field)
  return n <= max ? n : null
}

/** A step (`*\/N`) between 1 and max, or null. */
function stepOf(field: string, max: number): number | null {
  const m = EVERY.exec(field)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= max ? n : null
}

/** `at` decides whether Eastern time is EDT or EST for a daily schedule. */
export function scheduleInWords(cron: string, at: Date = new Date()): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null

  if (hour === '*') {
    if (minute === '*') return 'every minute'
    const everyMinutes = stepOf(minute, 59)
    if (everyMinutes !== null) return `every ${everyMinutes} minutes`
    const m = inRange(minute, 59)
    if (m === null) return null
    return m === 0 ? 'every hour on the hour' : `every hour at :${pad(m)}`
  }
  const m = inRange(minute, 59)
  if (m === null) return null
  const everyHours = stepOf(hour, 23)
  if (everyHours !== null) return `every ${everyHours} hours at :${pad(m)}`
  const h = inRange(hour, 23)
  if (h === null) return null

  const utc = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), h, m))
  const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(utc)
  return `daily at ${eastern} ET`
}

const pad = (n: number) => String(n).padStart(2, '0')
