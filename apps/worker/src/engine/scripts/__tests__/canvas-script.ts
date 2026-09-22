/**
 * Runs a canvas code node script the way the sandbox does (#1414).
 *
 * The deployer wraps every script as
 *   async (payload, steps, env, execution, console, props, fetch) => {
 *     const trigger = { payload }
 *     const process = { env }
 *     props = props || {}
 *     <script>
 *   }
 * (lib/code-node-deployer.ts, buildBundledWorkerScript). This harness builds the
 * same function so a script kept in the repo is exercised with the same
 * parameters and the same synthesised locals, with `fetch` injected so a test
 * decides what the buyer answers. It is test code: the sandbox's console and
 * fetch capture are not reproduced, because the scripts under test do not read
 * what those record.
 */

export interface CanvasRun {
  payload: unknown
  steps: Record<string, { output: unknown } | undefined>
  env?: Record<string, unknown>
  execution?: Record<string, unknown>
  props?: Record<string, unknown>
  fetch?: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<CanvasResponse>
}

/** The parts of a Response the Engine scripts read. */
export interface CanvasResponse {
  status: number
  text(): Promise<string>
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>

export function compileCanvasScript(script: string): (...fnArgs: unknown[]) => Promise<unknown> {
  return new AsyncFunction(
    'payload', 'steps', 'env', 'execution', 'console', 'props', 'fetch',
    `const trigger = { payload }\nconst process = { env }\nprops = props || {}\n${script}`,
  )
}

export async function runCanvasScript(script: string, run: CanvasRun): Promise<unknown> {
  const fn = compileCanvasScript(script)
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
  const noFetch = async (input: string) => {
    throw new Error(`the script fetched ${input} but the test injected no fetch`)
  }
  return fn(run.payload, run.steps, run.env ?? {}, run.execution ?? {}, quiet, run.props ?? {}, run.fetch ?? noFetch)
}

/** A fetch that answers every call with one captured shape: the status and the body as text. */
export function answerWith(httpStatus: number, body: unknown): CanvasRun['fetch'] {
  return async () => ({ status: httpStatus, text: async () => JSON.stringify(body) })
}
