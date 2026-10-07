/**
 * Wait for `work`, but at most `ms` (#1851): the hung shape's post-response
 * work stuck behind the database is cut here, as the real 25 s budget would cut
 * it. The timer is cleared on every path, the rejected one included, and a
 * rejection is passed on rather than swallowed.
 */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  let cut: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<void>((resolve) => { cut = setTimeout(resolve, ms) })])
  } finally {
    if (cut !== undefined) clearTimeout(cut)
  }
}
