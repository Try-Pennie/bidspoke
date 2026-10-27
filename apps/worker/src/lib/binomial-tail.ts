/**
 * The chance of a count at least as far from a baseline share as the one seen,
 * if each of `n` events were the baseline's share again (#2851). A rate check
 * reads it so a shift of a handful of events is not a page: half of a 2.9%
 * share over 387 runs is 5 leads where 11 were expected, a 1 in 29 chance.
 *
 * Summed term by term in logs, because the first term ((1 - p) ** n) is below
 * the smallest double for the counts a busy window holds.
 */

function check(k: number, n: number, p: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0) throw new Error(`binomial tail: ${k} of ${n} is not a count`)
  if (!(p >= 0 && p <= 1)) throw new Error(`binomial tail: ${p} is not a share`)
}

/** The chance of `k` or fewer of `n`, each with chance `p`. */
export function chanceAtMost(k: number, n: number, p: number): number {
  check(k, n, p)
  if (k < 0) return 0
  if (k >= n || p === 0) return 1
  if (p === 1) return 0
  const step = Math.log(p) - Math.log1p(-p)
  let term = n * Math.log1p(-p)
  let sum = Math.exp(term)
  for (let i = 0; i < k; i++) {
    term += Math.log(n - i) - Math.log(i + 1) + step
    sum += Math.exp(term)
  }
  return Math.min(1, sum)
}

/** The chance of `k` or more of `n`, each with chance `p`. */
export function chanceAtLeast(k: number, n: number, p: number): number {
  check(k, n, p)
  return Math.min(1, Math.max(0, 1 - chanceAtMost(k - 1, n, p)))
}
