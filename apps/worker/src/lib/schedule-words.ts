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

/** `at` decides whether Eastern time is EDT or EST for a daily schedule. */
export function scheduleInWords(cron: string, at: Date = new Date()): string | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null

  if (hour === '*') {
    if (minute === '*') return 'every minute'
    const every = EVERY.exec(minute)
    if (every) return `every ${Number(every[1])} minutes`
    if (NUMBER.test(minute)) return Number(minute) === 0 ? 'every hour on the hour' : `every hour at :${pad(Number(minute))}`
    return null
  }
  if (!NUMBER.test(minute)) return null
  const everyHours = EVERY.exec(hour)
  if (everyHours) return `every ${Number(everyHours[1])} hours at :${pad(Number(minute))}`
  if (!NUMBER.test(hour)) return null

  const utc = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), Number(hour), Number(minute)))
  const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(utc)
  return `daily at ${eastern} ET`
}

const pad = (n: number) => String(n).padStart(2, '0')
