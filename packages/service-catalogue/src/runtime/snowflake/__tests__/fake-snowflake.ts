import type { ActionContext } from '../../types'

/**
 * TEST ONLY. A Snowflake SQL API stand in for the catalogue's Snowflake tests:
 * the connection bound fetch an action is handed, answering from a queue, and
 * recording every request it was asked to send. An Error in the queue is thrown
 * by fetch, as the connection bound fetch throws a refusal (an expired login, a
 * 429 turned into a requeue) or a lost connection.
 */

export interface SentRequest {
  readonly method: string
  readonly url: string
  readonly body: Record<string, unknown> | null
}

export type Answer = Response | Error | (() => Response)

export const TARGET = { account: 'ab12345.us-east-1', user: 'ops_reader', warehouse: 'ops_wh', role: 'ops_role' }
export const STATEMENTS_URL = 'https://ab12345.us-east-1.snowflakecomputing.com/api/v2/statements'

export interface FakeSnowflake {
  readonly ctx: ActionContext
  readonly sent: SentRequest[]
  readonly slept: number[]
  respond(...answers: Answer[]): void
  readonly controller: AbortController
}

export function fakeSnowflake(target: unknown = TARGET): FakeSnowflake {
  const queue: Answer[] = []
  const sent: SentRequest[] = []
  const slept: number[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: input, body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Snowflake has no answer queued for ${init?.method ?? 'GET'} ${input}`)
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : next
  }
  const ctx = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
  return { ctx, sent, slept, controller, respond: (...answers) => queue.push(...answers) }
}

/** A completed statement: one partition unless `partitions` says more. */
export function resultSet(
  columns: Array<{ name: string; type: string; scale?: number }>,
  data: Array<Array<string | null>>,
  opts: { numRows?: number; partitions?: number[]; handle?: string } = {},
): Response {
  return Response.json({
    statementHandle: opts.handle ?? '01b2c3d4-0000-0000-0000-000000000001',
    resultSetMetaData: {
      numRows: opts.numRows ?? data.length,
      rowType: columns.map((c) => ({ name: c.name, type: c.type, scale: c.scale ?? null, nullable: true })),
      ...(opts.partitions ? { partitionInfo: opts.partitions.map((rowCount) => ({ rowCount })) } : {}),
    },
    data,
  })
}

/** A later partition as Snowflake answers it: data only, no metadata. */
export const partition = (data: Array<Array<string | null>>) => Response.json({ data })

/** A statement still running: Snowflake's async answer. */
export const running = (handle = '01b2c3d4-0000-0000-0000-000000000001') =>
  Response.json({ code: '333334', message: 'Asynchronous execution in progress.', statementHandle: handle }, { status: 202 })

/** A statement Snowflake refused, with its own code. */
export const statementError = (status: number, code: string, message: string) =>
  Response.json({ code, message, sqlState: '42000' }, { status })
