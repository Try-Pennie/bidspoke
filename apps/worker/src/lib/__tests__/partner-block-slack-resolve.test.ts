/**
 * A partner block is independent of Supabase, so its alert must not depend on Supabase
 * either (#1265, L682): when the Slack connection cannot be read, the last-good copy the
 * volume check keeps in KV is used instead, the same copy that lets that check speak during
 * a database outage. A block reported during a database wobble would otherwise be the one
 * alert that stays silent exactly when the team is already looking at Slack.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveSlackForBlockAlert } from '../partner-block-alert'

const conn = { bot_token: 'xoxb-live', default_channel: '#ops' }
const lastGood = { bot_token: 'xoxb-copy', default_channel: '#ops-copy' }

describe('resolveSlackForBlockAlert', () => {
  it('uses the live connection when the database answers', async () => {
    const readLastGood = vi.fn(async () => new Map([['org-1', lastGood]]))
    const got = await resolveSlackForBlockAlert('org-1', async () => conn, readLastGood)
    expect(got).toEqual(conn)
    expect(readLastGood).not.toHaveBeenCalled()
  })

  it('falls back to the last-good copy when the database read throws', async () => {
    const got = await resolveSlackForBlockAlert('org-1', async () => { throw new Error('db down') }, async () => new Map([['org-1', lastGood]]))
    expect(got).toEqual(lastGood)
  })

  it('returns null, never a stranger\'s connection, when neither source has this org', async () => {
    const got = await resolveSlackForBlockAlert('org-1', async () => null, async () => new Map([['org-2', lastGood]]))
    expect(got).toBeNull()
  })

  it('returns null when both sources fail, rather than throwing into the background task', async () => {
    const got = await resolveSlackForBlockAlert('org-1', async () => { throw new Error('db down') }, async () => { throw new Error('kv down') })
    expect(got).toBeNull()
  })
})
