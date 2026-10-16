/**
 * The one redaction of captured partners page responses (#2134), used by
 * capture-partners.mjs and checked by apps/web/e2e/partner-fixtures.test.ts.
 *
 * The fixtures are committed, so anything that identifies a person or works as
 * a credential is replaced before it is written (L155, L222), deterministically,
 * so a recapture of unchanged data writes the same bytes:
 *
 * - who last edited a row (updated_by, updated_by_email, updated_by_name)
 *   becomes Editor A, Editor B and so on, in order of first appearance. One
 *   person is one alias whichever of the three a row carries: a value already
 *   seen in any of them names the alias;
 * - a click route's address is a live webhook, which anyone holding it can call,
 *   so it becomes https://hooks.example.com/redacted/<route name>;
 * - a pasted sample response (last_probe_response) can hold a real lead's
 *   answer, so every text value in it becomes "redacted"; its keys, numbers and
 *   true or false stay, because they are the shape the extraction rules read.
 *
 * - a buyer profile is kept field by field from an allowlist (PROFILE_FIELDS),
 *   and a field the list does not name is refused, so a field added to the
 *   document later is never committed without someone deciding it is safe;
 *   a blackout date's note is text a person typed, so it becomes "redacted".
 *
 * What stays is configuration the page shows and a person needs to recognise:
 * partner names and slugs, proxy endpoints on Pennie's own domain, the NAME of a
 * Worker secret (cf_secret_key holds the name, never the value), rules and caps.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The buyer profile fields a fixture may keep (the document parseProfileDocument reads). */
const PROFILE_FIELDS = new Set([
  'partner_id', 'version', 'sold_on', 'is_enabled', 'priority', 'allowed_states', 'debt_min', 'debt_max', 'loan_amount_min',
  'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents', 'display_time_zone', 'windows', 'blackout_dates', 'tiers', 'click_delivery',
])

/** Editor A to Z, then A2 to Z2 and on, so an alias never repeats. */
const letterOf = (n) => `${LETTERS[n % 26]}${n >= 26 ? Math.floor(n / 26) + 1 : ''}`

/** Every text value in a sample response replaced, its shape kept. */
function redactSample(value) {
  if (typeof value === 'string') return 'redacted'
  if (Array.isArray(value)) return value.map(redactSample)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSample(v)]))
  return value
}

/** A redactor whose editor aliases are stable across every row it is given. */
export function createRedactor() {
  const aliases = new Map()
  let next = 0
  const aliasOf = (values) => {
    const known = values.find((v) => aliases.has(v))
    const n = known !== undefined ? aliases.get(known) : next++
    for (const v of values) aliases.set(v, n)
    return n
  }
  return {
    partner(row) {
      const out = { ...row }
      const has = (k) => row[k] !== null && row[k] !== undefined && row[k] !== ''
      const values = ['updated_by', 'updated_by_email', 'updated_by_name'].filter(has).map((k) => row[k])
      if (values.length > 0) {
        const n = aliasOf(values)
        // Only a field with a value of its own is rewritten: an empty one stays empty.
        if (has('updated_by')) out.updated_by = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`
        if (has('updated_by_email')) out.updated_by_email = `editor-${letterOf(n).toLowerCase()}@example.com`
        if (has('updated_by_name')) out.updated_by_name = `Editor ${letterOf(n)}`
      }
      if ('last_probe_response' in out && out.last_probe_response !== null) out.last_probe_response = redactSample(out.last_probe_response)
      return out
    },
    profile(doc) {
      if (!doc) return doc
      for (const key of Object.keys(doc)) {
        if (!PROFILE_FIELDS.has(key)) throw new Error(`redact: buyer profile field ${key} is not on the list of fields a fixture may keep, so nothing was written`)
      }
      const out = { ...doc }
      if (Array.isArray(out.blackout_dates)) out.blackout_dates = out.blackout_dates.map((b) => ({ ...b, note: b.note === null || b.note === undefined ? b.note : 'redacted' }))
      if (out.click_delivery) {
        if (!Array.isArray(out.click_delivery.routes)) throw new Error('redact: click_delivery.routes is not a list, so its addresses cannot be replaced and nothing was written')
        out.click_delivery = {
          ...out.click_delivery,
          routes: out.click_delivery.routes.map((r) => ({ ...r, url: `https://hooks.example.com/redacted/${encodeURIComponent(r.name)}` })),
        }
      }
      return out
    },
    /**
     * A History answer (#2141): each person who made a change becomes the same
     * Editor alias the partner rows give them (by user id, name or email), the
     * stamped actor of a change likewise, a click route's address the same
     * placeholder a profile's gets, a held click's prospect and the buyer's lead
     * id "redacted", and a matrix row's Salesforce link removed. Labels a job or
     * a direct edit carries name no person and stay.
     */
    history(answer) {
      const personName = (values) => `Editor ${letterOf(aliasOf(values))}`
      const entries = answer.entries.map((e) => {
        const out = { ...e }
        if (e.editor && e.editor.kind === 'person') {
          const n = aliasOf([e.editor.userId, e.editor.name].filter((v) => v))
          const name = `Editor ${letterOf(n)}`
          out.editor = { ...e.editor, name, userId: e.editor.userId ? `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}` : null }
          if (!e.editorLabel.includes(e.editor.name)) throw new Error(`redact: an editor label does not carry its editor's name, so it cannot be replaced and nothing was written`)
          out.editorLabel = e.editorLabel.split(e.editor.name).join(name)
        }
        out.changes = redactChanges(e.changes, personName)
        return out
      })
      return { ...answer, entries }
    },
  }
}

/** One History entry's changes with the identifying values replaced, its shape kept. */
function redactChanges(changes, personName) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return changes
  const out = {}
  for (const [key, v] of Object.entries(changes)) {
    if (key === '_actor' && v && typeof v === 'object') {
      const name = personName([v.name, v.email].filter((x) => x))
      out[key] = { ...v, name, ...('email' in v ? { email: `${name.toLowerCase().replace(' ', '-')}@example.com` } : {}) }
    } else if (/^click_delivery\.routes\[(.*)\]$/.test(key) && v && typeof v === 'object') {
      const route = /^click_delivery\.routes\[(.*)\]$/.exec(key)[1]
      const side = (s) => (s && typeof s === 'object' ? { ...s, url: `https://hooks.example.com/redacted/${encodeURIComponent(route)}` } : s)
      out[key] = { old: side(v.old), new: side(v.new) }
    } else if (key === 'subject' && v && typeof v === 'object') {
      out[key] = { ...v, ...('prospect_id' in v ? { prospect_id: 'redacted' } : {}) }
    } else if (key === 'buyer_lead_id' && v && typeof v === 'object') {
      out[key] = { old: v.old === null ? null : 'redacted', new: v.new === null ? null : 'redacted' }
    } else if (key === 'last_probe_response' && v && typeof v === 'object') {
      out[key] = { old: redactSample(v.old), new: redactSample(v.new) }
    } else if ((key === 'added' || key === 'removed' || key === 'edited') && Array.isArray(v)) {
      out[key] = v.map(({ source_url: _url, ...row }) => row)
    } else {
      out[key] = v
    }
  }
  return out
}

/** Every string in a value, so a test can assert nothing personal survived. */
export function stringsIn(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)])
  return []
}
