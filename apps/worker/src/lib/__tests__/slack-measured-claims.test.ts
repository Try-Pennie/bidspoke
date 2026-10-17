import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sendUpstreamOutageAlert,
  sendSecretDriftAlert,
  sendOutcomeDeadLetterAlert,
  sendUnconfirmedWritesAlert,
  sendDrainStallAlert,
  sendCronHeartbeatAlert,
  sendPgCronAlert,
  sendMatrixSyncFailureAlert,
  sendRequiredSecretsAlert,
  sendExportFailureAlert,
  sendDatabaseUnreachableAlert,
  sendDatabaseRecoveredAlert,
  DRAIN_STALL_SCHEDULES,
} from '../slack'
import { WRITEBACK_UNCAPTURABLE_LABEL, WRITEBACK_STORE_LABEL, WRITEBACK_HELD_LABEL } from '../../engine/writeback-deadletter'
import type { SlackConnection } from '../slack-connection'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

/**
 * Every sentence in the shared Slack alerts either follows from what the check
 * measured or is not said (#835, area D).
 *
 * Each test here pins a sentence that used to claim something the check never
 * measured, in the case where that claim was false, and asserts the derived
 * wording that replaced it. Each was run against the old copy and failed first.
 */

function makeSupabase(connection: Record<string, unknown> | null) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'maybeSingle')
          return () =>
            connection
              ? Promise.resolve({ data: { config: connection }, error: null })
              : Promise.resolve({ data: null, error: null })
        return () => chain
      },
    },
  )
  return { from: () => chain } as never
}

const slackConfig = {
  bot_token: 'xoxb-test',
  default_channel: '#alerts',
  workspace_name: 'Pennie',
  config_alerts_enabled: true,
}
const conn = { bot_token: 'xoxb-test', default_channel: '#alerts', config_alerts_enabled: true } as unknown as SlackConnection

/** Every word the last post put in front of a reader: the fallback text and each block. */
async function lastText(): Promise<string> {
  const body = (await slackPostOf(vi.mocked(fetch).mock.calls.at(-1) ?? []))
  const blockText = (b: { text?: { text?: string }; fields?: { text: string }[] }) => [
    b.text?.text ?? '',
    ...(b.fields ?? []).map((f) => f.text),
  ]
  return [body.text, ...body.blocks.flatMap(blockText)].join('\n')
}

// Built from char codes, so this file holds none of the characters it bans.
const BANNED = [String.fromCharCode(8212), String.fromCharCode(8211), ` ${String.fromCharCode(45)} `]
const expectHouseStyle = (text: string) => {
  for (const c of BANNED) expect(text).not.toContain(c)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('shared cause alert: says what was counted, not that a vendor is degraded', () => {
  const payload = {
    cause_key: 'missing_config',
    cause_label: 'Missing credentials/config',
    failure_count: 14,
    window_minutes: 1,
    workflow_names: ['Main Flow'],
    timestamp: '2026-10-14T15:00:00.000Z',
  }

  it('never calls a missing credential a degraded upstream', async () => {
    // "Missing credentials/config appears degraded" was the old lead: the cause
    // is our own configuration, and the how to check line already says so.
    await sendUpstreamOutageAlert(makeSupabase(slackConfig), 'org-1', payload, 'https://app.test')
    const text = (await lastText())
    expect(text).not.toMatch(/degraded/i)
    expect(text).toContain('14 leads')
    expect(text).toContain('Missing credentials/config')
    expectHouseStyle(text)
  })

  it('does not claim degradation for our own Apex either, which the how to check line rules out', async () => {
    await sendUpstreamOutageAlert(
      makeSupabase(slackConfig),
      'org-1',
      {
        ...payload,
        cause_key: 'salesforce',
        cause_label: 'Salesforce',
        how_to_check: 'The dominant error was raised by our own code or configuration running inside Salesforce.',
      },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).not.toMatch(/degraded/i)
    expect(text).toContain('Salesforce')
  })
})

describe('secret drift: the saved value is what workflows read', () => {
  it('does not say a workflow resolves to nothing, because the decrypted saved value wins', async () => {
    await sendSecretDriftAlert(conn, [{ key: 'EQ_PASS', scope: 'global', workflow_id: null }], 'https://app.test')
    const text = (await lastText())
    expect(text).not.toContain('resolves to nothing')
    expect(text).toMatch(/fallback/i)
    expect(text).toMatch(/cannot be decrypted/)
    expectHouseStyle(text)
  })
})

describe('outcome dead letter: the Supabase health line only for a code known to clear up', () => {
  it('sends a permission error to the error, not to Supabase health', async () => {
    // 42501 is not in the permanent list, so it used to read as "Supabase was
    // likely degraded". Waiting does not fix a missing grant.
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'permission denied for table lead_sightings', error_code: '42501' },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).not.toMatch(/likely degraded|Check Supabase health/)
    expect(text).toMatch(/Inspect the error above/)
  })

  it('does not call a full disk an overload that waiting clears', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'could not extend file: No space left on device', error_code: '53100' },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).not.toMatch(/overloaded or unreachable/)
    expect(text).toMatch(/Inspect the error above/)
  })

  it('still points at the database for a statement timeout, which is known to clear up', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'canceling statement due to statement timeout', error_code: '57014' },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).toMatch(/database/i)
    expect(text).toMatch(/memory/)
  })

  it('links the run when the loss carries one, rather than an execution log the alert does not show', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: 'outcome_writeback_deadletters.insert',
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'encryption failed',
        run: { workflow_id: 'wf-9', workflow_name: 'Main Flow', execution_id: 'ex-9', at: '2026-10-14T15:00:00Z' },
      },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).toContain('https://app.test/workflows/wf-9?execution=ex-9')
    expect(text).not.toContain('execution log below')
  })
})

describe('uncapturable writeback: its own wording', () => {
  const send = () =>
    sendOutcomeDeadLetterAlert(
      conn,
      {
        label: WRITEBACK_UNCAPTURABLE_LABEL,
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'sf_patch_lead: a create operation cannot be replayed, only an update',
        run: { workflow_id: 'wf-2', workflow_name: 'Main Flow', execution_id: 'ex-2', at: '2026-10-14T15:00:00Z' },
      },
      'https://app.test',
    )

  it('does not say it was retried or that it feeds billing', async () => {
    // The capture never retries anything: it found nothing a replay could resend.
    await send()
    const text = (await lastText())
    expect(text).not.toContain('failed after all retries')
    expect(text).not.toMatch(/billing/)
    expect(text).not.toContain('Outcome Record Lost')
    expect(text).toContain('a create operation cannot be replayed, only an update')
    expect(text).toContain('https://app.test/workflows/wf-2?execution=ex-2')
    expect(text).toMatch(/Fix:/)
    expectHouseStyle(text)
  })
})

// #2084: a held write the replay store could not save (encryption or the client
// threw before the retry ladder) went to the generic branch, which said "failed
// after all retries" and "feed billing". It is the same fact as an uncapturable
// write: the replay tool has nothing to resend.
describe('replay store failure: the uncapturable wording, not the generic one', () => {
  it('does not say it was retried or that it feeds billing', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: WRITEBACK_STORE_LABEL,
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'encrypting the held request failed: key ring empty',
        run: { workflow_id: 'wf-3', workflow_name: 'Main Flow', execution_id: 'ex-3', at: '2026-10-14T15:00:00Z' },
      },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).not.toContain('failed after all retries')
    expect(text).not.toMatch(/billing/)
    expect(text).toContain('Salesforce update cannot be replayed')
    expect(text).toContain('key ring empty')
    expect(text).toContain('https://app.test/workflows/wf-3?execution=ex-3')
    expectHouseStyle(text)
  })
})

// #2163: a timed out Prospect update was announced as "cannot be replayed", its
// request "could not be kept", and the reader sent to a run page that showed no
// request, while the at-risk record held it in KV until it expired unread. A held
// update, on any object, now says what is true: it may not have landed, here is
// the record and the fields to check, the run shows the values, and the request is
// held until a stated time in ET.
describe('held update: says it is unknown and held, and until when', () => {
  const send = (n = 1) =>
    sendOutcomeDeadLetterAlert(
      conn,
      {
        label: WRITEBACK_HELD_LABEL,
        window_loss_count: n,
        window_minutes: 30,
        error_message: 'Step timed out after 1500ms (in-flight upstream call canceled via abort signal)',
        run: {
          workflow_id: 'wf-7',
          workflow_name: 'Engine Bidding Workflow',
          execution_id: '01a13cf7-0191-7dc3-aada-59ceeacc1616',
          at: '2026-10-15T00:29:54Z',
          held: {
            step: 'patch_prospect_reject',
            sf_object: 'Prospect__c',
            sf_record_id: 'a06Ui00002sLkNuIAK',
            fields: ['BidStatus__c', 'RejectionReason__c'],
            until: '2026-10-16T00:29:54.000Z',
          },
        },
      },
      'https://app.test',
    )

  it('names the record, the fields and the ET expiry, and never says it cannot be replayed or was lost', async () => {
    await send()
    const text = (await lastText())
    expect(text).toContain('Salesforce update not confirmed')
    expect(text).toContain('Prospect a06Ui00002sLkNuIAK')
    expect(text).toContain('BidStatus__c and RejectionReason__c')
    // 00:29:54 UTC on Oct 16 is 8:29 PM EDT on Oct 15.
    expect(text).toContain('until 8:29 PM ET on Oct 15')
    expect(text).not.toMatch(/cannot be replayed|could not be kept|lost|UTC/)
    expect(text).toMatch(/Fix:/)
    expectHouseStyle(text)
  })

  // The failed step logs its input now (#2163), so the run is where the values
  // are; the alert names that place and keeps the values themselves out of Slack.
  it('points at the run for the values it was sending, after the field names, and shows no value', async () => {
    await send()
    const text = (await lastText())
    expect(text).toContain('BidStatus__c and RejectionReason__c. The run below shows the values it was sending.')
    expect(text).not.toMatch(/Rejected|unqualified_lead/)
  })

  // The label alone means unknown and held, so a payload that lost its record
  // details still must not fall into the generic "failed after all retries,
  // feeds billing" wording, which claims a loss nobody measured.
  it('keeps the held wording when the record details are missing, and never claims a loss', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: WRITEBACK_HELD_LABEL,
        window_loss_count: 2,
        window_minutes: 30,
        error_message: 'Step timed out after 1500ms',
      },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).toContain('Salesforce update not confirmed')
    expect(text).not.toMatch(/after all retries|feeds billing|cannot be replayed|lost/)
    expect(text).toMatch(/Fix:/)
    expectHouseStyle(text)
  })

  it('names a held Submission by its id the same way', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      {
        label: WRITEBACK_HELD_LABEL,
        window_loss_count: 1,
        window_minutes: 30,
        error_message: 'Step timed out after 10000ms',
        run: {
          workflow_id: 'wf-8',
          workflow_name: 'Liberty1 Click',
          execution_id: 'ex-8',
          at: '2026-10-15T14:00:00Z',
          held: { step: 'update_submission', sf_object: 'Submission__c', sf_record_id: 'a04Ui00000NkhG1IAJ', fields: ['External_Exchange_Status__c'], until: '2026-10-16T14:00:00.000Z' },
        },
      },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).toContain('Submission a04Ui00000NkhG1IAJ, setting External_Exchange_Status__c.')
    expect(text).toContain('until 10:00 AM ET on Oct 16')
    expectHouseStyle(text)
  })

  it('says it names the latest when the window holds more than one', async () => {
    await send(4)
    const text = (await lastText())
    expect(text).toContain('about 4 times')
    expect(text).toContain('names the latest')
    expectHouseStyle(text)
  })
})

describe('records could not be confirmed: points at our own database', () => {
  it('names the database health and memory, not the status page, and not a title the lost alert may not carry', async () => {
    await sendUnconfirmedWritesAlert(
      conn,
      { count: 2, labels: ['lead_sightings.finalize'], oldest_at: '2026-10-08T12:20:32Z', minutes: 15, runs: [] },
      'https://app.test',
    )
    const text = (await lastText())
    expect(text).not.toContain('status page')
    expect(text).not.toContain('Outcome Record Lost')
    expect(text).toMatch(/memory/)
    expectHouseStyle(text)
  })
})

describe('strand drain stall: the real schedule and the real consequence', () => {
  it('names the jobs that run today and says the rows are held back from the export', async () => {
    await sendDrainStallAlert(makeSupabase(slackConfig), 'org-1', 1234)
    const text = (await lastText())
    // The old copy named 08:00 and 08:30 UTC daily drains and a 09:00 export
    // that "records them with a null winner". The export takes only finalized rows.
    expect(text).not.toContain('08:00')
    expect(text).not.toMatch(/null winner/)
    expect(text).toMatch(/only finalized/)
    expect(text).toContain('reduce-finalize-stranded-deep')
    expect(text).toContain('finalize-unrecoverable-stranded')
    expect(text).toContain(':27 and :57')
    // Unmeasured guesses at a cause are not listed.
    expect(text).not.toMatch(/Common causes/)
    expectHouseStyle(text)
  })

  it('quotes the schedules it is given, which a web guard ties to the migrations', () => {
    expect(Object.keys(DRAIN_STALL_SCHEDULES).sort()).toEqual([
      'finalize-unrecoverable-stranded',
      'reduce-finalize-stranded',
      'reduce-finalize-stranded-deep',
    ])
  })
})

describe('heartbeat unstamped: names a failed stamp write, and does not assert health from job_runs', () => {
  it('does not claim nothing calls writeHeartbeat, which a guard makes impossible', async () => {
    await sendCronHeartbeatAlert(
      makeSupabase(slackConfig),
      'org-1',
      { label: 'Execution archive', triggerCron: '23 * * * *', dependents: 'run history is not backed up' },
      'unstamped',
      null,
    )
    const text = (await lastText())
    expect(text).not.toMatch(/nothing calls/)
    expect(text).not.toMatch(/is working/)
    expect(text).toContain('[cron-heartbeat]')
    expect(text).toMatch(/by hand/)
    expectHouseStyle(text)
  })
})

describe('pg_cron alert: remedies the check has not already ruled out', () => {
  const send = (status: string, detail: string) =>
    sendPgCronAlert(makeSupabase(slackConfig), 'org-1', { jobname: 'refresh-stats', status, detail }, '45 3 * * *')

  it('stalled points at a hung run or a scheduler that is not launching, not at cron.job', async () => {
    // A job missing from cron.job is not in the health read at all, and a
    // disabled one is reported as inactive, so neither can be why this fired.
    await send('stalled', 'last succeeded 50h ago')
    const text = (await lastText())
    expect(text).not.toMatch(/still present and active/)
    expect(text).toContain('job_run_details')
    expect(text).toMatch(/end_time/)
    // No claim about failures at all. The health read counts failures over a
    // fixed window, so an older one is out of view, and judgeJob also reaches
    // stalled after a failure inside the window that was reported and recovered.
    // What stalled measured is that the job is scheduled, enabled, and has not
    // succeeded for longer than its schedule allows, so that is all it says.
    expect(text).not.toMatch(/no run has failed/)
    expect(text).toContain('has not succeeded for longer than its schedule allows')
    expect(text).toMatch(/a failed row names its error/)
  })

  it('an unreadable last success time has its own wording, not the schedule remedy', async () => {
    await send('unreadable_success', "the last success time 'x' could not be read, so staleness cannot be judged")
    const text = (await lastText())
    expect(text).not.toMatch(/simplify the schedule/)
    expect(text).toContain('pg_cron_health')
  })
})

describe('bid matrix sync: the remedy follows the error', () => {
  it('a database write failure is not sent to Salesforce availability', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'bid_matrix_rows upsert failed: canceling statement due to statement timeout' }],
      preserved: [],
    })
    const text = (await lastText())
    expect(text).not.toMatch(/Salesforce availability/)
    expect(text).toMatch(/database/i)
  })

  it('a missing credential names the credential fix', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'Salesforce credentials missing for the bid matrix sync: SALESFORCE_CLIENT_ID (checked the org env store and the Worker env)' }],
      preserved: [],
    })
    const text = (await lastText())
    expect(text).not.toMatch(/Salesforce availability/)
    expect(text).toMatch(/Environment Variables/)
  })

  it('a Salesforce error still points at Salesforce', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'Salesforce query failed (503): Service Unavailable' }],
      preserved: [],
    })
    expect((await lastText())).toMatch(/Salesforce/)
  })

  it('a preserved matrix points at the partner flag filter', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, { failed: [], preserved: [{ config_slug: 'sofi' }] })
    const text = (await lastText())
    expect(text).toContain('Is{Partner}__c')
    expect(text).not.toMatch(/Salesforce availability/)
  })
})

describe('required secrets: no redeploy step', () => {
  it('does not ask for a redeploy, because putting a secret deploys it', async () => {
    await sendRequiredSecretsAlert(makeSupabase(slackConfig), 'org-1', ['EQ_PASS'])
    const text = (await lastText())
    expect(text).not.toMatch(/redeploy/)
    expect(text).toContain('wrangler secret put EQ_PASS --name bidspoke-worker')
  })
})

describe('export failure: the consequence follows each error phase', () => {
  const send = (jobName: string, errors: string[]) =>
    sendExportFailureAlert(makeSupabase(slackConfig), 'org-1', null, { jobName, errors })

  it('a sandbox purge failure does not claim rows were not exported', async () => {
    await send('Achieve export', ['sandbox purge: canceling statement due to statement timeout'])
    const text = (await lastText())
    expect(text).not.toMatch(/not exported/)
    expect(text).toMatch(/never exported/)
  })

  it('an enrollment view backfill failure says the export was not held up', async () => {
    await send('Achieve export', ['enrollment view backfill: Salesforce query failed (503)'])
    const text = (await lastText())
    expect(text).not.toMatch(/were not exported/)
    expect(text).toMatch(/enrollment view/)
  })

  it('a stamp that matched zero rows after the MERGE says the rows are already in Snowflake', async () => {
    await send('Lead sightings export', [
      'sightings export: lead_sightings.exported_at (500 rows; the batch would re-export forever): write matched zero rows (the target row does not exist)',
    ])
    const text = (await lastText())
    expect(text).not.toMatch(/were not exported/)
    expect(text).toMatch(/already in Snowflake/)
  })

  it('a purge job keeps the purge consequence when its error carries some other prefix', async () => {
    // The job name decides for a purge job whatever the line starts with: a
    // Cloudflare edge page or a Supabase error is still a purge that fell behind,
    // and its rows are already in Snowflake.
    for (const error of ['error code: 522', 'Supabase error: canceling statement due to statement timeout']) {
      await send('Sightings purge', [error])
      const text = (await lastText())
      expect(text, error).not.toMatch(/were not exported/)
      expect(text, error).toMatch(/already exported to Snowflake/)
    }
  })

  it('a real export failure keeps the not exported sentence', async () => {
    await send('Lead sightings export', ['bids export: Snowflake 401: JWT token is invalid'])
    expect((await lastText())).toMatch(/not exported/)
  })

  it('says each consequence once when several errors share a phase', async () => {
    await send('Achieve export', ['sandbox purge: a', 'sandbox purge: b'])
    const text = (await lastText())
    expect(text.match(/never exported/g)?.length).toBe(1)
  })
})

describe('database unreachable: no 503 claim, and a fix that matches the error', () => {
  it('does not say leads are refused with 503, which stored copies ended', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { what: 'workflows', error: 'TypeError: fetch failed', appUrl: 'https://app.test', copyAgeMs: null })
    const text = (await lastText())
    expect(text).not.toMatch(/503/)
    expect(text).toMatch(/recovers on its own/)
  })

  // #2058, #2117: on 2026-10-14 the reads failed with Cloudflare's own page
  // ("error code: 1016", it could not resolve the origin) while Supabase served
  // no errors at all. What was measured is that Cloudflare answered, not that
  // the database is down, so the page says that and quotes the code.
  it('a Cloudflare error page says the worker could not reach the database through Cloudflare, and quotes the code', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { what: 'slack connections', error: 'error code: 1016', appUrl: 'https://app.test', copyAgeMs: null })
    const text = (await lastText())
    expect(text).toMatch(/Bidspoke cannot reach its database through Cloudflare/)
    expect(text).toContain('`error code: 1016`')
    expect(text).toMatch(/cloudflarestatus\.com/)
    expect(text).not.toMatch(/status\.supabase\.com/)
    expect(text).not.toMatch(/Bidspoke cannot read its database/)
  })

  it.each(['error code: 522', 'Supabase read failed: error code: 1101'])('reads %s as a Cloudflare page too', async (error) => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { what: 'workflows', error, appUrl: 'https://app.test', copyAgeMs: null })
    expect((await lastText())).toMatch(/through Cloudflare/)
  })

  it('an ordinary database error keeps the database wording', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { what: 'workflows', error: 'Supabase error: canceling statement due to statement timeout (57014)', appUrl: 'https://app.test', copyAgeMs: null })
    const text = (await lastText())
    expect(text).toMatch(/Bidspoke cannot read its database/)
    expect(text).toMatch(/status\.supabase\.com/)
    expect(text).not.toMatch(/Cloudflare/)
  })

  it('a missing function does not recover on its own, so the alert does not say it will', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', {
      what: 'execution counts',
      // As formatErr renders a PostgREST error: the message, then the code.
      error: 'Could not find the function public.execution_counts_per_minute in the schema cache (PGRST202)',
      appUrl: 'https://app.test',
      copyAgeMs: null,
    })
    const text = (await lastText())
    expect(text).not.toMatch(/recovers on its own/)
    expect(text).toMatch(/migration/)
  })
})

// #2061: the page has one owner now, told by every scheduled read, so it no
// longer says the minute volume check could not read, and it names how old the
// Slack settings it is posted with are, once.
describe('database unreachable: one owner, and the saved settings named by age', () => {
  const base = { what: 'workflows', error: 'TypeError: fetch failed', appUrl: 'https://app.test', copyAgeMs: 12 * 60_000 }

  it.each([['database', base.error], ['Cloudflare', 'error code: 1016']])('the %s page names the copy age once and not the minute volume check', async (_, error) => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { ...base, error })
    const text = (await lastText())
    expect(text).not.toMatch(/minute volume check/)
    expect(text.match(/alerts during this outage are posted using Slack settings saved 12 minutes ago/gi)?.length).toBe(1)
    expectHouseStyle(text)
  })

  it('says the age is unknown, never a guess, for a copy written before it was dated', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { ...base, copyAgeMs: null })
    expect((await lastText())).toMatch(/Slack settings saved at a time that was not recorded/)
  })

  it('says under a minute rather than 0 minutes', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { ...base, copyAgeMs: 20_000 })
    expect((await lastText())).toMatch(/Slack settings saved less than a minute ago/)
  })

  it('the all-clear says what was measured', async () => {
    const measured = 'For the last 31 minutes the minute database probe and the volume check have answered, at least every 5 minutes, and no scheduled read has failed.'
    await sendDatabaseRecoveredAlert(conn, '#alerts', { alertedAt: '2026-10-15T02:00:00.000Z', endedAt: '2026-10-15T02:20:00.000Z', measured, appUrl: 'https://app.test' })
    const text = (await lastText())
    expect(text).toContain(measured)
    expect(text).toMatch(/Bidspoke\* can read its database again/)
    expectHouseStyle(text)
  })
})
