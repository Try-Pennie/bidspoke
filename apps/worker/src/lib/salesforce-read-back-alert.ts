/**
 * The wording of the Salesforce read-back's alerts (#2023). The read-back
 * (lib/salesforce-read-back.ts) decides what to say; this composes the words, and
 * slack.ts only lays them out.
 *
 * Every alert names the record and the field names a write set. The one place
 * a value appears is the conflict alert (#2264): for each field left out it
 * names the value Salesforce held and the value Bidspoke was sending, so the
 * person can decide without opening the run, and what the field's history
 * said. Those values come from the tick that decided, and are never stored.
 * Times are in ET.
 *
 * A credit inquiry post (#2172) sets no field by name, so its alerts are worded
 * as a post for its Submission, with the check a person can make: the Inquiries
 * file on that Submission's Lead. The read-back never groups posts with updates.
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
  /** The held request itself could not be opened with the encryption key. */
  | 'held_unreadable'

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
  /**
   * conflict: each left out field's value in Salesforce and the value Bidspoke
   * was sending, and what the field's history says (#2264). Known only on the
   * tick that decided it, so an alert sent again on a later tick goes without.
   */
  conflict_values?: Array<{ field: string; held: unknown; sending: unknown; history: 'changed' | 'not_kept' | 'unread'; changed_at?: string }>
  /** A credit inquiry post (#2172) rather than an update: it sets no field by name, and is worded as a post. */
  inquiry_post?: true
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
  /** unread and not_running: how many of those are credit inquiry posts (#2172). Absent when none are. */
  inquiry_posts?: number
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

/** "Main Flow posted a lead's credit inquiries ... for Submission X", the opening every post alert shares. */
const posted = (w: ReadBackAlertWrite) =>
  `${plain(w.workflow_name)} posted a lead's credit inquiries to Salesforce at ${clock(w.first_attempt_at)} ET, for ${record(w)}`

function postResendFailed(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  const title = 'Credit inquiry post could not be resent'
  const [w] = p.writes
  const why = (x: ReadBackAlertWrite) => plain(x.detail ?? 'Salesforce refused it')
  if (p.writes.length === 1) {
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${posted(w)}, and the post did not land. ` +
          (w.resent === false ? `Bidspoke did not send it again, because ${why(w)}.` : `Bidspoke sent it again and it failed: ${why(w)}.`),
        "Bidspoke will not send it again. Until the lead's next credit pull, its Lead keeps the inquiry rows and counts it had before.",
        'Fix: open that Submission in Salesforce and check why the post was refused. The run below shows what Bidspoke was sending, if its step was recorded.',
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  return {
    title,
    fallback: `${title}: ${p.writes.length} posts`,
    sections: [
      `${p.writes.length} credit inquiry posts to Salesforce did not land, and Bidspoke could not send them again. Bidspoke will not send them again.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${record(x)}. ${why(x)}.`),
      'Fix: open each Submission in Salesforce and check why its post was refused. Each run shows what Bidspoke was sending, if its step was recorded.',
    ],
  }
}

function postUnknown(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  const title = 'Credit inquiry post still not confirmed'
  const [w] = p.writes
  if (p.writes.length === 1) {
    const until = clockOnDay(w.expires_at)
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${posted(w)}, and the post did not land in time. ` +
          (w.resends === 0
            ? 'Bidspoke found no Inquiries file on its Lead, and has not been able to send it again.'
            : `Bidspoke sent it again ${times(w.resends)}, and Salesforce did not confirm it, so it is still not known whether it landed.`),
        w.still_trying
          ? `Bidspoke keeps trying, and holds the post until ${until}.`
          : `Bidspoke will not send it again, because each post that lands attaches another file to the Lead. It holds the post until ${until}.`,
        `Fix: before ${until}, open that Submission's Lead in Salesforce and look for an Inquiries file from ${clock(w.first_attempt_at)} ET or later. If there is none, the post did not land.`,
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  const until = clockOnDay(earliest(p.writes))
  return {
    title,
    fallback: `${title}: ${p.writes.length} posts`,
    sections: [
      `${p.writes.length} credit inquiry posts to Salesforce did not land in time, and Bidspoke has not been able to confirm any of them since, so it is still not known whether they landed.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${record(x)}.`),
      `Fix: before ${until}, when the first held post is deleted, open each Submission's Lead in Salesforce and look for an Inquiries file from the time shown or later. If there is none, that post did not land.`,
    ],
  }
}

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

/** How long a value an alert quotes may be, so one long text field cannot fill the message. */
export const QUOTED_VALUE_MAX = 80

/** A Salesforce value as an alert quotes it: text in straight quotes, blank as nothing. */
function quoted(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'nothing'
  const text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  const cut = text.length > QUOTED_VALUE_MAX ? `${text.slice(0, QUOTED_VALUE_MAX)}...` : text
  return typeof v === 'string' ? `"${plain(cut)}"` : plain(cut)
}

type ConflictValue = NonNullable<ReadBackAlertWrite['conflict_values']>[number]

/** One sentence per left out field: the two values, and what its history says about who set the one Salesforce holds. */
function valueSentence(v: ConflictValue): string {
  const values = `${plain(v.field)} held ${quoted(v.held)} where Bidspoke was sending ${quoted(v.sending)}.`
  if (v.history === 'changed' && v.changed_at) return `${values} Its Salesforce history shows it was changed at ${clockOnDay(v.changed_at)}, after the update began.`
  if (v.history === 'not_kept') return `${values} Salesforce keeps no history of that field, so whether another writer set it could not be checked.`
  return `${values} Its Salesforce history could not be read, so whether another writer set it could not be checked.`
}

/** The values sentences of a write, or null when this alert does not carry them (one sent again on a later tick). */
function valuesOf(w: ReadBackAlertWrite): string | null {
  const values = w.conflict_values ?? []
  if (values.length === 0 || values.length !== (w.conflict_fields ?? []).length) return null
  return values.map(valueSentence).join(' ')
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
    const values = valuesOf(w)
    const [only] = w.conflict_values ?? []
    const fix = !values
      ? `Fix: open that ${objectName(w.sf_object)} in Salesforce and decide whether ${n === 1 ? 'that field should keep its' : 'those fields should keep their'} current ${n === 1 ? 'value' : 'values'}. The run below shows the values Bidspoke was sending, if its step was recorded.`
      : n === 1
        ? `Fix: open that ${objectName(w.sf_object)} in Salesforce and decide whether ${plain(only.field)} should keep ${quoted(only.held)} or be set to ${quoted(only.sending)}.`
        : `Fix: open that ${objectName(w.sf_object)} in Salesforce and decide, for each of those fields, whether it should keep the value it holds or be set to the one Bidspoke was sending.`
    return {
      title,
      fallback: `${title}: ${record(w)}`,
      sections: [
        `${plain(w.workflow_name)} answered a lead at ${clock(w.first_attempt_at)} ET, and a Salesforce update after the answer did not land. ${what(w)}`,
        ...(values ? [values] : []),
        ...(rates ? [rates] : []),
        fix,
        runLink(appUrl, w, 'View the run →'),
      ],
    }
  }
  return {
    title,
    fallback: `${title}: ${p.writes.length} updates`,
    sections: [
      `${p.writes.length} Salesforce updates made after leads were answered did not land, and when Bidspoke sent them again some fields already held a different value, so those fields were left as they were.`,
      lines(p.writes, appUrl, (x) => `${plain(x.workflow_name)} at ${clock(x.first_attempt_at)} ET: ${what(x)}${valuesOf(x) ? ` ${valuesOf(x)}` : ''}`),
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
  held_unreadable: {
    why: 'its encryption key would not open what it holds, so nothing can check or resend it',
    fix: 'check whether the encryption key was changed without following its rotation steps',
  },
}

/**
 * What is waiting, with its verb: the updates as before, the credit inquiry posts
 * by name (#2172), or both with how many of each.
 */
function waiting(n: number, posts = 0): string {
  const updates = n - posts
  const update = (k: number) => (k === 1 ? '1 update' : `${k} updates`)
  const post = (k: number) => (k === 1 ? '1 credit inquiry post' : `${k} credit inquiry posts`)
  if (posts <= 0) return `${n === 1 ? '1 Salesforce update' : `${n} Salesforce updates`} made after leads were answered ${n === 1 ? 'is' : 'are'}`
  if (updates <= 0) return `${post(posts)} to Salesforce ${posts === 1 ? 'is' : 'are'}`
  return `${n} Salesforce writes (${post(posts)} and ${update(updates)} made after leads were answered) are`
}

function unread(p: SalesforceReadBackAlert): ComposedAlert {
  const title = p.inquiry_posts ? 'Salesforce writes waiting to be checked' : 'Salesforce updates waiting to be checked'
  const n = p.count ?? 0
  const because = UNREAD_BECAUSE[p.reason ?? 'salesforce_not_answering']
  const until = p.oldest_expires_at ? clockOnDay(p.oldest_expires_at) : 'its deletion'
  return {
    title,
    fallback: `${title}: ${n}`,
    sections: [
      `${waiting(n, p.inquiry_posts)} waiting to be read back, the oldest from ${p.oldest_at ? clock(p.oldest_at) : 'an unknown time'} ET. ` +
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
      `${waiting(n, p.inquiry_posts)} waiting to be read back, the oldest from ${p.oldest_at ? clock(p.oldest_at) : 'an unknown time'} ET, ` +
        `and the job that reads them back has not finished a run ${since}.`,
      `Until it runs, nothing confirms or resends them. Each held request is deleted 24 hours after it was made, the oldest at ${until}.`,
      "Fix: check the worker's minute cron, and its logs for the Salesforce read back.",
    ],
  }
}

export function composeSalesforceReadBackAlert(p: SalesforceReadBackAlert, appUrl: string): ComposedAlert {
  switch (p.kind) {
    case 'resend_failed':
      return p.writes.every((w) => w.inquiry_post) && p.writes.length > 0 ? postResendFailed(p, appUrl) : resendFailed(p, appUrl)
    case 'unknown':
      return p.writes.every((w) => w.inquiry_post) && p.writes.length > 0 ? postUnknown(p, appUrl) : unknown(p, appUrl)
    case 'conflict':
      return conflict(p, appUrl)
    case 'unread':
      return unread(p)
    case 'not_running':
      return notRunning(p)
  }
}
