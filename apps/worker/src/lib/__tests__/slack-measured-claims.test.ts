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
  DRAIN_STALL_SCHEDULES,
} from '../slack'
import { WRITEBACK_UNCAPTURABLE_LABEL } from '../../engine/writeback-deadletter'
import type { SlackConnection } from '../slack-connection'

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
function lastText(): string {
  const body = JSON.parse((vi.mocked(fetch).mock.calls.at(-1)?.[1] as { body: string }).body)
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
    const text = lastText()
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
    const text = lastText()
    expect(text).not.toMatch(/degraded/i)
    expect(text).toContain('Salesforce')
  })
})

describe('secret drift: the saved value is what workflows read', () => {
  it('does not say a workflow resolves to nothing, because the decrypted saved value wins', async () => {
    await sendSecretDriftAlert(conn, [{ key: 'EQ_PASS', scope: 'global', workflow_id: null }], 'https://app.test')
    const text = lastText()
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
    const text = lastText()
    expect(text).not.toMatch(/likely degraded|Check Supabase health/)
    expect(text).toMatch(/Inspect the error above/)
  })

  it('does not call a full disk an overload that waiting clears', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'could not extend file: No space left on device', error_code: '53100' },
      'https://app.test',
    )
    const text = lastText()
    expect(text).not.toMatch(/overloaded or unreachable/)
    expect(text).toMatch(/Inspect the error above/)
  })

  it('still points at the database for a statement timeout, which is known to clear up', async () => {
    await sendOutcomeDeadLetterAlert(
      conn,
      { label: 'lead_sightings.insert', window_loss_count: 1, window_minutes: 30, error_message: 'canceling statement due to statement timeout', error_code: '57014' },
      'https://app.test',
    )
    const text = lastText()
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
    const text = lastText()
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
    const text = lastText()
    expect(text).not.toContain('failed after all retries')
    expect(text).not.toMatch(/billing/)
    expect(text).not.toContain('Outcome Record Lost')
    expect(text).toContain('a create operation cannot be replayed, only an update')
    expect(text).toContain('https://app.test/workflows/wf-2?execution=ex-2')
    expect(text).toMatch(/Fix:/)
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
    const text = lastText()
    expect(text).not.toContain('status page')
    expect(text).not.toContain('Outcome Record Lost')
    expect(text).toMatch(/memory/)
    expectHouseStyle(text)
  })
})

describe('strand drain stall: the real schedule and the real consequence', () => {
  it('names the jobs that run today and says the rows are held back from the export', async () => {
    await sendDrainStallAlert(makeSupabase(slackConfig), 'org-1', 1234)
    const text = lastText()
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
    const text = lastText()
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
    const text = lastText()
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
    const text = lastText()
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
    const text = lastText()
    expect(text).not.toMatch(/Salesforce availability/)
    expect(text).toMatch(/database/i)
  })

  it('a missing credential names the credential fix', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'Salesforce credentials missing for the bid matrix sync: SALESFORCE_CLIENT_ID (checked the org env store and the Worker env)' }],
      preserved: [],
    })
    const text = lastText()
    expect(text).not.toMatch(/Salesforce availability/)
    expect(text).toMatch(/Environment Variables/)
  })

  it('a Salesforce error still points at Salesforce', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, {
      failed: [{ config_slug: 'sofi', error: 'Salesforce query failed (503): Service Unavailable' }],
      preserved: [],
    })
    expect(lastText()).toMatch(/Salesforce/)
  })

  it('a preserved matrix points at the partner flag filter', async () => {
    await sendMatrixSyncFailureAlert(makeSupabase(slackConfig), 'org-1', null, { failed: [], preserved: [{ config_slug: 'sofi' }] })
    const text = lastText()
    expect(text).toContain('Is{Partner}__c')
    expect(text).not.toMatch(/Salesforce availability/)
  })
})

describe('required secrets: no redeploy step', () => {
  it('does not ask for a redeploy, because putting a secret deploys it', async () => {
    await sendRequiredSecretsAlert(makeSupabase(slackConfig), 'org-1', ['EQ_PASS'])
    const text = lastText()
    expect(text).not.toMatch(/redeploy/)
    expect(text).toContain('wrangler secret put EQ_PASS --name bidspoke-worker')
  })
})

describe('export failure: the consequence follows each error phase', () => {
  const send = (jobName: string, errors: string[]) =>
    sendExportFailureAlert(makeSupabase(slackConfig), 'org-1', null, { jobName, errors })

  it('a sandbox purge failure does not claim rows were not exported', async () => {
    await send('Achieve export', ['sandbox purge: canceling statement due to statement timeout'])
    const text = lastText()
    expect(text).not.toMatch(/not exported/)
    expect(text).toMatch(/never exported/)
  })

  it('an enrollment view backfill failure says the export was not held up', async () => {
    await send('Achieve export', ['enrollment view backfill: Salesforce query failed (503)'])
    const text = lastText()
    expect(text).not.toMatch(/were not exported/)
    expect(text).toMatch(/enrollment view/)
  })

  it('a stamp that matched zero rows after the MERGE says the rows are already in Snowflake', async () => {
    await send('Lead sightings export', [
      'sightings export: lead_sightings.exported_at (500 rows; the batch would re-export forever): write matched zero rows (the target row does not exist)',
    ])
    const text = lastText()
    expect(text).not.toMatch(/were not exported/)
    expect(text).toMatch(/already in Snowflake/)
  })

  it('a purge job keeps the purge consequence when its error carries some other prefix', async () => {
    // The job name decides for a purge job whatever the line starts with: a
    // Cloudflare edge page or a Supabase error is still a purge that fell behind,
    // and its rows are already in Snowflake.
    for (const error of ['error code: 522', 'Supabase error: canceling statement due to statement timeout']) {
      await send('Sightings purge', [error])
      const text = lastText()
      expect(text, error).not.toMatch(/were not exported/)
      expect(text, error).toMatch(/already exported to Snowflake/)
    }
  })

  it('a real export failure keeps the not exported sentence', async () => {
    await send('Lead sightings export', ['bids export: Snowflake 401: JWT token is invalid'])
    expect(lastText()).toMatch(/not exported/)
  })

  it('says each consequence once when several errors share a phase', async () => {
    await send('Achieve export', ['sandbox purge: a', 'sandbox purge: b'])
    const text = lastText()
    expect(text.match(/never exported/g)?.length).toBe(1)
  })
})

describe('database unreachable: no 503 claim, and a fix that matches the error', () => {
  it('does not say leads are refused with 503, which stored copies ended', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', { what: 'workflows', error: 'TypeError: fetch failed', appUrl: 'https://app.test' })
    const text = lastText()
    expect(text).not.toMatch(/503/)
    expect(text).toMatch(/recovers on its own/)
  })

  it('a missing function does not recover on its own, so the alert does not say it will', async () => {
    await sendDatabaseUnreachableAlert(conn, '#alerts', {
      what: 'execution counts',
      // As formatErr renders a PostgREST error: the message, then the code.
      error: 'Could not find the function public.execution_counts_per_minute in the schema cache (PGRST202)',
      appUrl: 'https://app.test',
    })
    const text = lastText()
    expect(text).not.toMatch(/recovers on its own/)
    expect(text).toMatch(/migration/)
  })
})
