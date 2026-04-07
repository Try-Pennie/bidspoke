const ET = 'America/New_York'

/** "Apr 7, 2026, 2:34 PM EDT" */
export function formatDatetime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(dateStr))
}

/** "Apr 7, 2026" — for list columns where time isn't relevant */
export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(dateStr))
}

/** "2:34 PM" — for execution list sidebar timestamps */
export function formatTime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(dateStr))
}

/** "Today" / "Yesterday" / "Apr 7" — for execution list date group headers */
export function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  // Compare calendar dates in ET
  const fmt = (dt: Date) => new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt)
  const today = fmt(now)
  const yesterday = fmt(new Date(now.getTime() - 86_400_000))
  const dStr = fmt(d)
  if (dStr === today) return 'Today'
  if (dStr === yesterday) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
  }).format(d)
}
