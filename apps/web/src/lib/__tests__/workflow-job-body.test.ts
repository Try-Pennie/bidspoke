import { describe, expect, it } from 'vitest'
import { workflowJobBody, workflowJobIds } from './_scan-utils'

/**
 * One shared slicer for the workflow guard tests (#1066).
 *
 * Six guards each hand-carved a job out of ci.yml, and three of them did it by
 * naming the job that happens to FOLLOW the one they wanted (`a11y:` to
 * `auth-gate:`). The job splits in this milestone insert and rename jobs, so
 * those slicers would not go red, they would quietly return a different job's
 * body and go on asserting about the wrong place (L135).
 *
 * So the slicing is derived from the two-space job keys, never from a
 * neighbour's name, and asking for a job that is not there is a loud failure
 * naming the jobs that ARE there rather than an empty string that every
 * `expect(body).not.toMatch(...)` would happily accept (L215, L100).
 */
const YAML = [
  'name: Example',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  first:',
  '    name: First',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo first',
  '',
  '  # a comment between jobs',
  '  second:',
  '    name: Second',
  '    steps:',
  '      - run: echo second',
  '',
  '  last:',
  '    name: Last',
  '    steps:',
  '      - run: echo last',
  '',
].join('\n')

describe('workflowJobBody (#1066)', () => {
  it('returns only the named job, not the one that follows it', () => {
    const body = workflowJobBody(YAML, 'first')

    expect(body).toContain('echo first')
    expect(body).not.toContain('echo second')
    expect(body).not.toContain('echo last')
  })

  it('starts at the job key, so the body includes the job own attributes', () => {
    expect(workflowJobBody(YAML, 'second')).toContain('name: Second')
  })

  it('reaches the end of the file for the last job', () => {
    const body = workflowJobBody(YAML, 'last')

    expect(body).toContain('echo last')
    expect(body).not.toContain('echo second')
  })

  it('keeps a comment that sits between two jobs out of the earlier job', () => {
    expect(workflowJobBody(YAML, 'first')).not.toContain('a comment between jobs')
  })

  it('throws and names the jobs it did find when the id is absent', () => {
    expect(() => workflowJobBody(YAML, 'nope')).toThrowError(/nope/)
    expect(() => workflowJobBody(YAML, 'nope')).toThrowError(/first, second, last/)
  })

  it('refuses a file with no jobs block rather than returning nothing', () => {
    expect(() => workflowJobBody('name: Empty\n', 'first')).toThrowError(/jobs:/)
  })

  it('lists every job id in file order', () => {
    expect(workflowJobIds(YAML)).toEqual(['first', 'second', 'last'])
  })
})
