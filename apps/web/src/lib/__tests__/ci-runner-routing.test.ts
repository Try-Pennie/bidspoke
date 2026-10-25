import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowFiles, workflowIf, workflowJobBody, workflowJobIds, workflowSteps } from './_scan-utils'

/**
 * Where every job runs is decided by ONE org variable, PENNIE_CI_RUNNER (#2768).
 *
 * From 2026-10-23 GitHub refused every hosted job in the Try-Pennie org over
 * billing, while self-hosted runners still got jobs. So the jobs moved to the
 * runners on Dan's work MacBook, labelled `pennie-mac`, as Slate's did
 * (Try-Pennie/slate#4208). One of them, `pennie-mac-docker`, can reach Docker;
 * no Bidspoke job needs Docker today, and one that starts to must ask for it.
 *
 * The switch back has to be one setting with no code change: a job goes to the
 * Mac only when the variable is EXACTLY `pennie-mac`, and to GitHub's
 * `ubuntu-latest` for anything else (missing, empty, `github`, a typo).
 *
 * A routed job must also be able to RUN on a Mac: a command macOS lacks fails it
 * as "command not found", and a fixed port collides with the other jobs (Slate's
 * included) sharing that one machine, or answers from somebody's dev server.
 *
 * The repository went public on 2026-10-25, so anybody can fork it and open a
 * pull request, and a pull request job runs that stranger's code. On the Mac
 * that is code run on Dan's work MacBook. So a job reaches the Mac only when
 * its event carries no pull request, or a pull request whose head branch lives
 * in this repository; a fork's, or one whose head repository is gone, goes to
 * GitHub's runner whatever the variable says. Keyed on the payload rather than
 * the event name, so a pull_request_target or review trigger added later is
 * held to it too.
 */

const ROUTED =
  /^\$\{\{ vars\.PENNIE_CI_RUNNER == 'pennie-mac' && \(!github\.event\.pull_request \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) && '([\w-]+)' \|\| 'ubuntu-latest' \}\}$/

const REPOSITORY = 'Try-Pennie/bidspoke'

/** The part of an event the expression reads: absent for a push or schedule, else the pull request's head repository. */
type RunEvent = { pullRequestHead: string | null } | undefined

/** What GitHub resolves a `runs-on` to for a value of the variable and an event, or null when it is not routed. */
function resolve(runsOn: string, variable: string, event: RunEvent = undefined): string | null {
  const m = ROUTED.exec(runsOn)
  if (!m) return null
  // `a && b && 'x' || 'y'`: the label is a non-empty string, so this is a ternary.
  const ownCode = event === undefined || event.pullRequestHead === REPOSITORY
  return variable === 'pennie-mac' && ownCode ? m[1] : 'ubuntu-latest'
}

// Jobs left on GitHub's runners, each with its reason. None today.
const STAYS_ON_GITHUB: Record<string, string> = {}

// A job needs Docker when it uses a service container, a job container or the
// Docker CLI (the SQL suite starts Postgres in Docker).
const NEEDS_DOCKER = /\bdocker\b|^ {4}services:|^ {4}container:|sql-suite\/run\.sh|supabase (start|db dump)/m

// Commands a Mac runner lacks or cannot use. `timeout-minutes` is the job key,
// not GNU timeout. Bare `pip install` is refused by Homebrew's Python (PEP 668),
// and the runner user owns neither /usr/local/bin nor sudo.
const LINUX_ONLY = /\b(setsid|sha256sum|apt-get|sudo|pipx)\b|\btimeout \d|\bpip install\b|-b \/usr\/local\/bin/

// A fixed port is shared by every job on the one machine.
const FIXED_PORT = /localhost:\d{2,5}\b|--port \d/

const stripComments = (s: string) => s.replace(/^\s*#.*$/gm, '')

/** The job's code with every Linux only step removed (each has a Mac twin, checked below). */
function codeOnAMac(jobBody: string): string {
  const head = jobBody.split(/\n(?= {6}- )/)[0]
  const steps = workflowSteps(jobBody).filter((s) => !/runner\.os == 'Linux'/.test(workflowIf(s.body, 8) ?? ''))
  return stripComments([head, ...steps.map((s) => s.body)].join('\n')).replace(/timeout-minutes/g, '')
}

const jobs = workflowFiles().flatMap((file) => {
  const yaml = readWorkflow(file)
  return workflowJobIds(yaml).map((id) => ({ file, id, body: workflowJobBody(yaml, id) }))
})

describe('the runner switch', () => {
  it('resolves known answers', () => {
    const expr =
      "${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && (!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository) && 'pennie-mac' || 'ubuntu-latest' }}"
    expect(resolve(expr, 'pennie-mac')).toBe('pennie-mac')
    expect(resolve(expr, 'pennie-mac', { pullRequestHead: REPOSITORY })).toBe('pennie-mac')
    // A stranger's fork, and a pull request whose fork was deleted, never reach the Mac.
    expect(resolve(expr, 'pennie-mac', { pullRequestHead: 'someone/bidspoke' })).toBe('ubuntu-latest')
    expect(resolve(expr, 'pennie-mac', { pullRequestHead: null })).toBe('ubuntu-latest')
    // The routing #2768 shipped, with no fork clause, is refused.
    expect(resolve("${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && 'pennie-mac' || 'ubuntu-latest' }}", 'pennie-mac')).toBeNull()
    expect(resolve(expr, '')).toBe('ubuntu-latest')
    expect(resolve(expr, 'github')).toBe('ubuntu-latest')
    expect(resolve(expr, 'Pennie-Mac')).toBe('ubuntu-latest')
    expect(resolve('ubuntu-latest', 'pennie-mac')).toBeNull()
    // A bare fallback would make any value of the variable a runner label.
    expect(resolve("${{ vars.PENNIE_CI_RUNNER || 'ubuntu-latest' }}", 'pennie-mac')).toBeNull()
  })

  it('reads every job in every workflow', () => {
    // Known answer on 2026-10-24: 29 jobs in 7 workflows. Zero would mean the
    // scan found nothing, not that nothing needed checking (L98).
    expect(workflowFiles().length).toBeGreaterThanOrEqual(7)
    expect(jobs.length).toBeGreaterThanOrEqual(29)
  })

  it.each(jobs.map((j) => [`${j.file} ${j.id}`, j] as const))('%s runs where the variable says', (_, job) => {
    const runsOn = /^ {4}runs-on: *(.+)$/m.exec(job.body)?.[1].trim()
    expect(runsOn, 'runs-on the test can read').toBeDefined()
    if (STAYS_ON_GITHUB[`${job.file} ${job.id}`]) {
      expect(runsOn).toBe('ubuntu-latest')
      return
    }
    const expected = NEEDS_DOCKER.test(stripComments(job.body)) ? 'pennie-mac-docker' : 'pennie-mac'
    expect(resolve(runsOn!, 'pennie-mac')).toBe(expected)
    expect(resolve(runsOn!, '')).toBe('ubuntu-latest')
    expect(resolve(runsOn!, 'pennie-mac', { pullRequestHead: 'someone/bidspoke' })).toBe('ubuntu-latest')

    const code = codeOnAMac(job.body)
    expect(LINUX_ONLY.exec(code)?.[0], 'a command a Mac runner lacks').toBeUndefined()
    expect(FIXED_PORT.exec(code)?.[0], 'a fixed port shared with every other job on the Mac').toBeUndefined()
  })

  it('needs no Docker runner today', () => {
    // If this moves, the Docker job must ask for pennie-mac-docker (checked above),
    // and only one runner carries it, so two Docker jobs never share ports.
    expect(jobs.filter((j) => NEEDS_DOCKER.test(stripComments(j.body))).map((j) => `${j.file} ${j.id}`)).toEqual([])
  })
})

describe('Linux only steps', () => {
  const linuxSteps = jobs.flatMap((job) =>
    workflowSteps(job.body)
      .filter((s) => /runner\.os == 'Linux'/.test(workflowIf(s.body, 8) ?? ''))
      .map((s) => ({ job, step: s })),
  )

  it('are the three security scanner installs', () => {
    expect(linuxSteps.map((s) => s.step.name)).toEqual(['Install Trivy', 'Install gitleaks', 'Install Semgrep'])
  })

  it.each(linuxSteps.map((s) => [s.step.name, s] as const))('%s has a Mac twin that needs no sudo', (name, { job }) => {
    const twin = workflowSteps(job.body).find((s) => s.name === `${name} (Mac runner)`)
    expect(twin, `"${name} (Mac runner)"`).toBeDefined()
    expect(workflowIf(twin!.body, 8)).toMatch(/runner\.os == 'macOS'/)
    // Both keep the job's !cancelled(), so a failed earlier guard still lets the scan install.
    expect(workflowIf(twin!.body, 8)).toMatch(/!cancelled\(\)/)
    expect(stripComments(twin!.body)).not.toMatch(/\bsudo\b|\/usr\/local\/bin|\bpip install\b/)
  })
})
