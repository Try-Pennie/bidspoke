/**
 * Answering the Slack alert row read in a chainable test double (#2332).
 *
 * getSlackConnection and its siblings used to end their read in
 * `.maybeSingle()`, which answered one row object or null. Since #2332 the
 * read asks for the alert row only and ends in `.limit(2)`, awaited directly,
 * so more than one candidate is seen and refused by name: the answer is an
 * array. A double that served the old read's single row answers the new one
 * through this, from the same single row answer, so what each test asserts
 * about the connection is unchanged.
 */
type Answer = { data: unknown; error: unknown }

/**
 * The all organization alert row read (#2332) for a double: a builder whose
 * filters (`eq`, `or`, and the scheduled client's `retry` and `abortSignal`)
 * each return it, and which settles to `answer` when awaited. Stands in for
 * the old `select().eq('service_type', 'slack')` double, which settled on
 * its one `eq`.
 */
export function alertRowListAnswer(answer: Answer | Promise<Answer>): PromiseLike<Answer> {
  const builder: Record<string, unknown> = {}
  // `order` and `range`: the read pages past the row cap (#1437); one page answers it all.
  for (const m of ['eq', 'or', 'order', 'range', 'retry', 'abortSignal']) builder[m] = () => builder
  builder.then = (resolve?: (v: Answer) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(answer).then(resolve, reject)
  return builder as unknown as PromiseLike<Answer>
}

/** A `.limit()` for a double, settling to the rows the single row answer stood for. */
export function alertRowsAnswer(single: () => Answer | Promise<Answer>): () => PromiseLike<Answer> {
  return () => ({
    then<A, B = never>(resolve?: ((v: Answer) => A | PromiseLike<A>) | null, reject?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return Promise.resolve(single())
        .then((r): Answer => ({ ...r, data: r.error ? null : r.data === null || r.data === undefined ? [] : [r.data] }))
        .then(resolve, reject)
    },
  })
}
