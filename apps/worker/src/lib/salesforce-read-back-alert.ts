/**
 * The wording of the Salesforce read-back's alerts (#2023). The read-back
 * (lib/salesforce-read-back.ts) decides what to say; this composes the words, and
 * slack.ts only lays them out.
 *
 * Every alert names the record and the field names a write set, never a value:
 * the values are lead data, and the run page shows them when its step was logged.
 * Times are in ET.
 */

export type ReadBackAlertKind = 'resend_failed' | 'unknown' | 'conflict' | 'unread' | 'not_running'

/** Why a tick read nothing, in the words the unread alert uses. */
export type UnreadReason =
  | 'salesforce_not_answering'
  | 'salesforce_login'
  | 'bulkhead_busy'
  | 'bulkhead_unknown'
  | 'credentials'
  | 'tick_full'

export interface ReadBackAlertWrite {
  workflow_id: string
  workflow_name: string
  execution_id: string
  sf_object: string
  sf_record_id: string
  /** The fields the write set, never the marker. */
  fields: string[]
  /** ISO: when the run's step started, just after the lead was answered. */
  first_attempt_at: string
  /** ISO: when the held request is deleted. */
  expires_at: string
  /** Resends sent so far: each counted once its claim is won, just before it is sent. */
  resends: number
  /** resend_failed: what Salesforce said, in words. */
  detail?: string
  /** unknown: whether the read-back still has a resend left to try. */
  still_trying?: boolean
  /** conflict: the fields left out because each held a different value. */
  conflict_fields?: string[]
  /** conflict: whether the other fields were written. */
  resent?: boolean
}

export interface SalesforceReadBackAlert {
  kind: ReadBackAlertKind
  writes: ReadBackAlertWrite[]
  /** conflict: per field, how often today a resend found it moved, of the resends that carried it. */
  conflict_rates?: Array<{ sf_object: string; field: string; conflicts: number; candidates: number }>
  /** unread and not_running: how many writes are waiting. */
  count?: number
  /** ISO: the oldest waiting write's step start. */
  oldest_at?: string
  /** ISO: when the oldest waiting write's request is deleted. */
  oldest_expires_at?: string
  /** unread: why nothing was read. */
  reason?: UnreadReason
  /** not_running: the read-back's last finished run, ISO, or null when it never finished one. */
  last_finished_at?: string | null
}

export interface ComposedAlert {
  title: string
  /** One Slack section each, in order. */
  sections: string[]
  /** The notification text. */
  fallback: string
}

/** How many writes one alert names; the rest are counted. */
export const NAMED_WRITES = 10

const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
const day = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(new Date(iso))
const clockOnDay = (iso: string) => `${clock(iso)} ET on ${day(iso)}`

/** Prospect__c reads as Prospect, the way Salesforce's own pages name the record. */
export const objectName = (sfObject: string): string => sfObject.replace(/__c$/, '').replace(/_/g, ' ')

/** Text made safe inside mrkdwn, as slack.ts does it: `<`, `>` and `&` are markup there. */
function plain(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const runLink = (appUrl: string, w: ReadBackAlertWrite, label: string) =>
  `<${appUrl}/workflows/${w.workflow_id}?execution=${w.execution_id}|${label}>`

const record = (w: ReadBackAlertWrite) => `${objectName(w.sf_object)} ${plain(w.sf_record_id)}`
const fieldList = (fields: string[]) => list(fields.map(plain))
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** One line per write for an alert naming several, with its run. */
function lines(writes: ReadBackAlertWrite[], appUrl: string, line: (w: ReadBackAlertWrite) => string): string {
  const shown = writes.slice(0, NAMED_WRITES)
  const more = writes.length > shown.length ? `\nand ${writes.length - shown.length} more` : ''
  return shown.map((w) => `${line(w)} ${runLink(appUrl, w, 'View the run →')}`).join('\n') + more
}

const earliest = (writes: ReadBackAlertWrite[]) => writes.map((w) => w.expires_at).sort()[0]

function resendFailed(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  const title = 'Salesforce update could not be resent'
  const [w] = p.writes
  if (p.writes.length === 1) {
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${plain(w.workflow_name)} answered a lead at ${clock(w.first_attempt_at)} ET, and a Salesforce update after the answer did not land. ` +
          `Bidspoke sent it again and it failed: ${plain(w.detail ?? 'Salesforce refused it')}. It was updating ${record(w)}, setting ${fieldList(w.fields)}.`,
        'Bidspoke will not send it again. The run below shows the values it was sending, if its step was recorded.',
        `Fix: open that ${objectName(w.sf_object)} in Salesforce and set ${w.fields.length === 1 ? 'that field' : 'those fields'} by hand, unless the refusal was right.`,
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  return {
    title,
    fallback: `${title}: ${p.writes.length} updates`,
    sections: [
      `${p.writes.length} Salesforce updates made after leads were answered did not land, and each failed again when Bidspoke sent it again. Bidspoke will not send them again.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${record(x)}, setting ${fieldList(x.fields)}. ${plain(x.detail ?? 'Salesforce refused it')}.`),
      'Fix: open each record in Salesforce and set those fields by hand, unless the refusal was right. Each run shows the values it was sending, if its step was recorded.',
    ],
  }
}

function unknown(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  const title = 'Salesforce update still not confirmed'
  const [w] = p.writes
  if (p.writes.length === 1) {
    const until = clockOnDay(w.expires_at)
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${plain(w.workflow_name)} answered a lead at ${clock(w.first_attempt_at)} ET, and a Salesforce update after the answer did not land in time. ` +
          (w.resends === 0
            ? 'Bidspoke read the record back and the update was not there, and it has not been able to send it again. '
            : `Bidspoke sent it again ${times(w.resends)} without an answer from Salesforce, so it is still not known whether it landed. `) +
          `It was updating ${record(w)}, setting ${fieldList(w.fields)}.`,
        `${w.still_trying ? 'Bidspoke keeps trying, and holds' : 'Bidspoke has stopped trying, and holds'} the request until ${until}. The run below shows the values it was sending, if its step was recorded.`,
        `Fix: before ${until}, open that ${objectName(w.sf_object)} in Salesforce and check ${w.fields.length === 1 ? 'that field' : 'those fields'}. If the update did not land, set ${w.fields.length === 1 ? 'it' : 'them'} by hand.`,
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  const until = clockOnDay(earliest(p.writes))
  return {
    title,
    fallback: `${title}: ${p.writes.length} updates`,
    sections: [
      `${p.writes.length} Salesforce updates made after leads were answered did not land in time, and Bidspoke has not been able to confirm any of them since, so it is still not known whether they landed.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${record(x)}, setting ${fieldList(x.fields)}.`),
      `Fix: before ${until}, when the first held request is deleted, open each record in Salesforce and check those fields. If an update did not land, set its fields by hand.`,
    ],
  }
}

function conflict(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  const title = 'Salesforce update resent without some fields'
  const rates = (p.conflict_rates ?? [])
    .filter((r) => r.candidates > 0)
    .map((r) => `Today ${objectName(r.sf_object)} ${plain(r.field)} held a different value in ${r.conflicts} of ${r.candidates} resends.`)
    .join(' ')
  const what = (w: ReadBackAlertWrite) => {
    const moved = fieldList(w.conflict_fields ?? [])
    return w.resent
      ? `Bidspoke sent it again, leaving out ${moved}, because ${(w.conflict_fields ?? []).length === 1 ? 'that field already held' : 'each of those already held'} a different value. It updated ${record(w)} with the rest.`
      : `Bidspoke did not send it again, because every field it set on ${record(w)} (${moved}) already held a different value.`
  }
  const [w] = p.writes
  if (p.writes.length === 1) {
    const n = (w.conflict_fields ?? []).length
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${plain(w.workflow_name)} answered a lead at ${clock(w.first_attempt_at)} ET, and a Salesforce update after the answer did not land. ${what(w)}`,
        ...(rates ? [rates] : []),
        `Fix: open that ${objectName(w.sf_object)} in Salesforce and decide whether ${n === 1 ? 'that field should keep its' : 'those fields should keep their'} current ${n === 1 ? 'value' : 'values'}. The run below shows the values Bidspoke was sending, if its step was recorded.`,
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  return {
    title,
    fallback: `${title}: ${p.writes.length} updates`,
    sections: [
      `${p.writes.length} Salesforce updates made after leads were answered did not land, and when Bidspoke sent them again some fields already held a different value, so those fields were left as they were.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${what(x)}`),
      ...(rates ? [rates] : []),
      'Fix: open each record in Salesforce and decide whether those fields should keep their current values. Each run shows the values Bidspoke was sending, if its step was recorded.',
    ],
  }
}

const UNREAD_BECAUSE: Record<UnreadReason, { why: string; fix: string }> = {
  salesforce_not_answering: { why: 'Salesforce did not answer', fix: 'check whether Salesforce is slow or down for the Pennie org' },
  salesforce_login: { why: "Salesforce refused Bidspoke's login", fix: 'check the Bidspoke Integration user and its connected app in Salesforce' },
  bulkhead_busy: { why: "Bidspoke's limit on calls to Salesforce was full", fix: 'check whether Salesforce is slow, which is what fills that limit' },
  bulkhead_unknown: { why: "Bidspoke's limit on calls to Salesforce could not be asked", fix: 'check the worker logs for errors from the Salesforce limiter' },
  credentials: { why: 'the Salesforce settings for the workflow could not be loaded', fix: "check the workflow's Salesforce settings and that the database is answering" },
  tick_full: { why: 'there were more to read than fit in one minute', fix: 'nothing yet, since they are read oldest first, but if this repeats, check how many Salesforce writes are timing out' },
}

function unread(p: SalesforceReadBackAlert): ComposedAlert {
  const title = 'Salesforce updates waiting to be checked'
  const n = p.count ?? 0
  const because = UNREAD_BECAUSE[p.reason ?? 'salesforce_not_answering']
  const until = p.oldest_expires_at ? clockOnDay(p.oldest_expires_at) : 'its deletion'
  return {
    title,
    fallback: `${title}: ${n}`,
    sections: [
      `${n === 1 ? '1 Salesforce update' : `${n} Salesforce updates`} made after leads were answered ${n === 1 ? 'is' : 'are'} waiting to be read back, the oldest from ${p.oldest_at ? clock(p.oldest_at) : 'an unknown time'} ET. ` +
        `Bidspoke could not read ${n === 1 ? 'it' : 'them'} this minute because ${because.why}.`,
      `It keeps trying every minute. Each held request is deleted 24 hours after it was made, the oldest at ${until}.`,
      `Fix: ${because.fix}.`,
    ],
  }
}

function notRunning(p: SalesforceReadBackAlert): ComposedAlert {
  const title = 'Salesforce read back is not running'
  const n = p.count ?? 0
  const since = p.last_finished_at ? `since ${clockOnDay(p.last_finished_at)}` : 'since it was deployed'
  const until = p.oldest_expires_at ? clockOnDay(p.oldest_expires_at) : 'its deletion'
  return {
    title,
    fallback: `${title}: ${n} waiting`,
    sections: [
      `${n === 1 ? '1 Salesforce update' : `${n} Salesforce updates`} made after leads were answered ${n === 1 ? 'is' : 'are'} waiting to be read back, the oldest from ${p.oldest_at ? clock(p.oldest_at) : 'an unknown time'} ET, ` +
        `and the job that reads them back has not finished a run ${since}.`,
      `Until it runs, nothing confirms or resends them. Each held request is deleted 24 hours after it was made, the oldest at ${until}.`,
      "Fix: check the worker's minute cron, and its logs for the Salesforce read back.",
    ],
  }
}

export function composeSalesforceReadBackAlert(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  switch (p.kind) {
    case 'resend_failed':
      return resendFailed(p, appUrl)
    case 'unknown':
      return unknown(p, appUrl)
    case 'conflict':
      return conflict(p, appUrl)
    case 'unread':
      return unread(p)
    case 'not_running':
      return notRunning(p)
  }
}
