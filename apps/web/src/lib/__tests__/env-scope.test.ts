import { describe, it, expect } from 'vitest'
import { envKeysForWorkflow, usedByLabel } from '../env-scope'

const MAIN = 'wf-main'
const ACHIEVE = 'wf-achieve'
const SCOUT = 'wf-scout'
const GONE = 'wf-deleted'

const names = new Map([
  [MAIN, 'Main Flow'],
  [ACHIEVE, 'Achieve Offers'],
  [SCOUT, 'Eligibility Scout'],
])

const company = (key: string) => ({ key, scope: 'global', workflow_id: null })
const own = (key: string, workflow_id: string) => ({ key, scope: 'workflow', workflow_id })

describe('envKeysForWorkflow (#1774)', () => {
  it("offers every company key and the open workflow's own, never another workflow's", () => {
    const vars = [company('API_URL'), own('CHANNEL', MAIN), own('ONLY_ACHIEVE', ACHIEVE)]

    expect(envKeysForWorkflow(vars, MAIN)).toEqual(['API_URL', 'CHANNEL'])
  })

  it('offers a key once when the workflow sets its own value over a company one', () => {
    const vars = [company('CHANNEL'), own('CHANNEL', MAIN)]

    expect(envKeysForWorkflow(vars, MAIN)).toEqual(['CHANNEL'])
  })

  it('offers only company keys to a workflow with none of its own', () => {
    expect(envKeysForWorkflow([company('B'), company('A'), own('X', ACHIEVE)], MAIN)).toEqual(['A', 'B'])
  })
})

describe('usedByLabel (#1774)', () => {
  it('names the workflow a workflow row belongs to', () => {
    const row = own('CHANNEL', MAIN)

    expect(usedByLabel(row, [row], names)).toBe('Main Flow')
  })

  it('says a company row with no workflow value of its key is read by all workflows', () => {
    const row = company('API_URL')

    expect(usedByLabel(row, [row, own('OTHER', MAIN)], names)).toBe('All workflows')
  })

  it('names the workflows that read their own value of the key instead', () => {
    const row = company('CHANNEL')
    const vars = [row, own('CHANNEL', MAIN), own('CHANNEL', ACHIEVE)]

    expect(usedByLabel(row, vars, names)).toBe('All workflows except Achieve Offers and Main Flow')
  })

  it('counts rather than lists once more than two workflows set their own value', () => {
    const row = company('CHANNEL')
    const vars = [row, own('CHANNEL', MAIN), own('CHANNEL', ACHIEVE), own('CHANNEL', SCOUT)]

    expect(usedByLabel(row, vars, names)).toBe('All workflows except the 3 that set their own')
  })

  it('leaves a deleted workflow out of the exceptions, since it has no runs', () => {
    const row = company('CHANNEL')
    const vars = [row, own('CHANNEL', GONE), own('CHANNEL', MAIN)]

    expect(usedByLabel(row, vars, names)).toBe('All workflows except Main Flow')
  })

  it('says a workflow row whose workflow is deleted belongs to a deleted workflow', () => {
    const row = own('CHANNEL', GONE)

    expect(usedByLabel(row, [row], names)).toBe('A deleted workflow')
  })

  it('says so when the workflow names could not be loaded, rather than guessing', () => {
    const row = company('CHANNEL')
    const mine = own('CHANNEL', MAIN)

    expect(usedByLabel(mine, [row, mine], null)).toBe('Workflow name unavailable')
    expect(usedByLabel(row, [row, mine], null)).toBe('All workflows except the 1 that set their own')
    expect(usedByLabel(company('ALONE'), [company('ALONE')], null)).toBe('All workflows')
  })
})
