import { describe, expect, it, vi } from 'vitest'

/**
 * The cron guard check's three pages are three alerts (#2948): a fail open, a
 * skipped duplicate and a doubled tick. All three go out through the export
 * alert, so the title alone does not say which was refused; each is logged
 * under its own fixed kind.
 */
const h = vi.hoisted(() => ({
  sendExportFailureAlert: vi.fn(async (..._a: unknown[]) => true),
}))
vi.mock('../slack', async (importOriginal) => ({ ...(await importOriginal<object>()), sendExportFailureAlert: h.sendExportFailureAlert }))
vi.mock('../alert-fanout', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  forEachSlackOrg: async (_s: unknown, _l: string, _u: string, perOrg: (orgId: string) => Promise<boolean>) => ({ kind: 'ran', results: [await perOrg('org-1')] }),
}))

import { CRON_GUARD_ALERT_KINDS, sendCronGuardPage, type CronGuardPage } from '../cron-guard-watch'

describe('every cron guard page is logged under its own kind', () => {
  it('sends each page under the kind the map names, and no two pages share one', async () => {
    const pages: CronGuardPage[] = ['failed_open', 'skipped_duplicate', 'double_run']
    for (const page of pages) {
      expect(await sendCronGuardPage({} as never, page, { title: 'A cron guard page', errors: ['one'] } as never)).toBe(true)
    }
    expect(h.sendExportFailureAlert.mock.calls.map((c) => c[4])).toEqual(['cron-guard-failed-open', 'cron-guard-skipped-duplicate', 'cron-guard-double-run'])
    expect(new Set(pages.map((p) => CRON_GUARD_ALERT_KINDS[p])).size).toBe(pages.length)
  })
})
