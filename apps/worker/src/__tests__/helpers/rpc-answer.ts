/**
 * An rpc answer for a chainable test double (#1437).
 *
 * The rollup reads through rpc page past PostgREST's row cap, so they ask the
 * builder for `.order()` and `.range()` before awaiting it. This answers those
 * and then settles to `answer`, the whole list in one page, so what each test
 * asserts about the rows is unchanged.
 */
type Answer = { data: unknown; error: unknown }

export function rpcAnswer(answer: Answer | Promise<Answer>) {
  const builder = {
    order: () => builder,
    range: () => builder,
    then<A, B = never>(resolve?: ((v: Answer) => A | PromiseLike<A>) | null, reject?: ((e: unknown) => B | PromiseLike<B>) | null) {
      return Promise.resolve(answer).then(resolve, reject)
    },
  }
  return builder
}
