/**
 * The words of the dashboard's incident record (#2101), as settled with Dan on
 * 2026-10-14: the card grouped by day with only the hour on each row, and each
 * open incident one line under the page header.
 */
import { describe, it, expect } from 'vitest'
import {
  INCIDENT_RECORDING_BEGAN,
  emptyIncidentsText,
  failedRunsCell,
  failedRunsText,
  groupIncidentsByDay,
  incidentRunsRetentionLine,
  incidentRunsSpanLine,
  incidentRunsTitle,
  durationColumnText,
  incidentTimeRange,
  ongoingIncidentSentence,
  signalText,
  slackPagesText,
} from '../incidents'
import type { Incident, IncidentFailedRuns, OngoingIncident } from '../api'

// 6:12 PM ET on Wednesday 14 October 2026.
const NOW = Date.parse('2026-10-14T22:12:00.000Z')

function closed(over: Partial<Incident>): Incident {
  return {
    id: 'i',
    signal: 'volume-cliff',
    signal_label: 'Volume cliff',
    signal_known: true,
    subject_name: 'Main Flow',
    scope: 'org',
    started_at: '2026-10-14T18:34:00.000Z',
    ended_at: '2026-10-14T20:06:00.000Z',
    state: 'ended',
    duration: '1 hour 32 minutes',
    pages_sent: 2,
    failed_runs: null,
    ...over,
  }
}

function ongoing(over: Partial<OngoingIncident>): OngoingIncident {
  return {
    id: 'o',
    signal: 'partner-reachability',
    signal_label: 'Partner reachability',
    signal_known: true,
    subject_name: 'api.tripoint.com',
    scope: 'platform',
    started_at: '2026-10-14T20:52:00.000Z',
    so_far: '1 hour 20 minutes so far',
    pages_sent: 1,
    ...over,
  }
}

describe('slackPagesText', () => {
  it('counts pages in words', () => {
    expect(slackPagesText(1)).toBe('1 Slack page')
    expect(slackPagesText(3)).toBe('3 Slack pages')
    expect(slackPagesText(0)).toBe('0 Slack pages')
  })
})

describe('signalText', () => {
  it('is the label, with the raw key beside it only for an unrecognised signal', () => {
    expect(signalText(closed({}))).toBe('Volume cliff')
    expect(signalText(closed({ signal: 'retired-check', signal_label: 'Unrecognised signal', signal_known: false }))).toBe('Unrecognised signal (retired-check)')
  })
})

describe('incidentTimeRange', () => {
  it('gives the hours of an incident that ended on its day', () => {
    expect(incidentTimeRange(closed({}))).toBe('2:34 PM to 4:06 PM')
  })

  it('gives the end its day when it ended on a later one', () => {
    expect(incidentTimeRange(closed({ started_at: '2026-10-14T03:40:00.000Z', ended_at: '2026-10-14T04:20:00.000Z' }))).toBe('11:40 PM to Oct 14, 12:20 AM')
  })

  it('gives only the start when the end was not recorded, so the time column stays one line', () => {
    expect(incidentTimeRange(closed({ state: 'end_not_recorded', ended_at: null, duration: null, started_at: '2026-10-11T19:00:00.000Z' }))).toBe('3:00 PM')
  })
})

describe('durationColumnText', () => {
  it('is the measured duration of an ended incident', () => {
    expect(durationColumnText(closed({}))).toBe('1 hour 32 minutes')
  })

  it('says the end was not recorded where the duration would be, since there is none', () => {
    expect(durationColumnText(closed({ state: 'end_not_recorded', ended_at: null, duration: null }))).toBe('End not recorded')
  })
})

describe('groupIncidentsByDay', () => {
  it('heads each ET day once, in the order given, with the first heading saying the times are ET', () => {
    const rows = [
      closed({ id: 'a', started_at: '2026-10-14T18:34:00.000Z' }),
      closed({ id: 'b', started_at: '2026-10-14T13:00:00.000Z' }),
      closed({ id: 'c', started_at: '2026-10-14T01:12:00.000Z' }),
      closed({ id: 'd', started_at: '2026-10-12T15:20:00.000Z' }),
    ]
    const groups = groupIncidentsByDay(rows, NOW)
    expect(groups.map((g) => g.heading)).toEqual(['Today (times ET)', 'Yesterday', 'Mon, Oct 12'])
    expect(groups.map((g) => g.incidents.map((i) => i.id))).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('has no groups for no incidents', () => {
    expect(groupIncidentsByDay([], NOW)).toEqual([])
  })
})

describe('ongoingIncidentSentence', () => {
  it('names the signal, the subject, the start in ET, how long so far and the pages', () => {
    expect(ongoingIncidentSentence(ongoing({}), NOW)).toBe('Partner reachability on api.tripoint.com, since 4:52 PM ET, 1 hour 20 minutes so far. 1 Slack page.')
  })

  it('gives a start before today its day', () => {
    expect(ongoingIncidentSentence(ongoing({ started_at: '2026-10-12T20:52:00.000Z', so_far: '2 days so far', pages_sent: 4 }), NOW))
      .toBe('Partner reachability on api.tripoint.com, since Oct 12, 4:52 PM ET, 2 days so far. 4 Slack pages.')
  })

  it('leaves out how long when it is not known', () => {
    expect(ongoingIncidentSentence(ongoing({ so_far: null }), NOW)).toBe('Partner reachability on api.tripoint.com, since 4:52 PM ET. 1 Slack page.')
  })
})

describe('emptyIncidentsText', () => {
  it('names the window when it lies wholly inside the record', () => {
    const later = Date.parse('2026-11-30T12:00:00.000Z')
    expect(emptyIncidentsText(7, later, false)).toBe('No incidents in the last 7 days')
    expect(emptyIncidentsText(30, later, false)).toBe('No incidents in the last 30 days')
  })

  it('names when recording began when the window reaches before it', () => {
    expect(emptyIncidentsText(7, NOW, false)).toBe('No incidents since recording began on Oct 14')
    // 20 October: a 14 day window still starts before the record does.
    expect(emptyIncidentsText(14, Date.parse('2026-10-20T12:00:00.000Z'), false)).toBe('No incidents since recording began on Oct 14')
  })

  it('says "other" when an ongoing incident is shown above, so the card does not contradict it', () => {
    expect(emptyIncidentsText(7, Date.parse('2026-11-30T12:00:00.000Z'), true)).toBe('No other incidents in the last 7 days')
  })

  it('keeps the day recording began as one named constant', () => {
    expect(new Date(INCIDENT_RECORDING_BEGAN).toISOString()).toBe('2026-10-14T04:00:00.000Z')
  })
})

describe('the failed runs of a failure rate incident (#2102)', () => {
  const WF = 'aaaaaaaa-0000-4000-8000-000000000001'

  it('counts failed runs in words', () => {
    expect(failedRunsText(1)).toBe('1 failed run')
    expect(failedRunsText(12)).toBe('12 failed runs')
    expect(failedRunsText(0)).toBe('0 failed runs')
  })

  describe('the card cell', () => {
    it('links a counted incident to the workflow page narrowed to it', () => {
      const i = closed({ id: 'inc-1', signal: 'failure-rate', failed_runs: { workflow_id: WF, state: 'counted', count: 12 } })
      expect(failedRunsCell(i)).toEqual({ text: '12 failed runs', href: `/workflows/${WF}?incident=inc-1` })
    })

    it('says 0 as plain text, with nothing to open', () => {
      const i = closed({ signal: 'failure-rate', failed_runs: { workflow_id: WF, state: 'counted', count: 0 } })
      expect(failedRunsCell(i)).toEqual({ text: '0 failed runs', href: null })
    })

    it('shows nothing when none of the span is still kept, or the count could not be read', () => {
      expect(failedRunsCell(closed({ signal: 'failure-rate', failed_runs: { workflow_id: WF, state: 'not_kept' } }))).toBeNull()
      expect(failedRunsCell(closed({ signal: 'failure-rate', failed_runs: { workflow_id: WF, state: 'unreadable' } }))).toBeNull()
    })

    it('shows nothing for any other signal', () => {
      expect(failedRunsCell(closed({}))).toBeNull()
    })
  })

  describe('the narrowed run list', () => {
    function body(over: Partial<IncidentFailedRuns['incident']> = {}, rest: Partial<IncidentFailedRuns> = {}): IncidentFailedRuns {
      return {
        incident: { id: 'inc-1', workflow_id: WF, match: 'ACRO_GATEWAY', started_at: '2026-10-14T18:34:00.000Z', ended_at: '2026-10-14T20:06:00.000Z', ...over },
        kept_since: '2026-10-07T22:12:00.000Z',
        clipped: false,
        count: 0,
        runs: [],
        ...rest,
      }
    }

    it('titles the list with the count of its own rows', () => {
      expect(incidentRunsTitle(12)).toBe('12 failed runs in this incident')
      expect(incidentRunsTitle(1)).toBe('1 failed run in this incident')
    })

    it('names the match and the span in ET', () => {
      expect(incidentRunsSpanLine(body(), NOW)).toBe('"ACRO_GATEWAY", Today 2:34 PM to 4:06 PM ET')
    })

    it('gives an end on another day its day', () => {
      expect(incidentRunsSpanLine(body({ started_at: '2026-10-13T23:50:00.000Z', ended_at: '2026-10-14T05:10:00.000Z' }), NOW))
        .toBe('"ACRO_GATEWAY", Yesterday 7:50 PM to Oct 14, 1:10 AM ET')
    })

    it('reads an incident with no recorded end as since its start', () => {
      expect(incidentRunsSpanLine(body({ ended_at: null }), NOW)).toBe('"ACRO_GATEWAY", Today since 2:34 PM ET')
    })

    it('says runs before the cutoff are gone only when the span reaches before it', () => {
      expect(incidentRunsRetentionLine(body({}, { clipped: true, kept_since: '2026-10-08T14:00:00.000Z' }))).toBe('Runs before Oct 8 are no longer kept.')
      expect(incidentRunsRetentionLine(body())).toBeNull()
    })
  })
})
