/**
 * How a catalogue action fails by name (#2337). Its own small file, apart from
 * types.ts, because every run file imports it for its value and so its source
 * is part of every action's version fingerprint: a type added to types.ts must
 * not move them all.
 *
 * `outcome` is what the executor (#1950) needs to decide what may happen next,
 * since a non idempotent action is never repeated on an uncertain outcome:
 *  - `not_applied`: the service refused the request, so nothing it asked for happened.
 *  - `applied`: the service did what was asked, and the action failed afterwards
 *    (a result it could not read in full, a row cap), so repeating it would do it twice.
 *  - `unknown`: it cannot tell.
 *
 * Anything the connection bound fetch itself throws for a request the action had
 * not yet seen answered (an expired login, a 429 turned into a requeue, a lost
 * connection) is passed on unchanged rather than wrapped in one of these: the
 * executor reads those itself. An action wraps such an error only once something
 * it sent has already been applied, so a requeue can never repeat a write.
 */

export type ActionOutcome = 'not_applied' | 'applied' | 'unknown'

export class ActionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ActionOutcome,
  ) {
    super(message)
    this.name = 'ActionFailure'
  }
}
