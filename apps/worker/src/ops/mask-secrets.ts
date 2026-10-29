/**
 * Secret variable values masked out of what ops keeps (#2982, Dan's decision
 * of 2026-10-29: ops reads secrets, and "Secret values are masked in the step
 * results ops keeps"). The one masking implementation for ops: the step test
 * uses it (step-test.ts, #3002), and a run's step records (#2998) are to use
 * it too rather than a second copy.
 *
 * Given a value and the secrets a step was given (variable name to value), it
 * answers a copy with every occurrence of each value, inside any string at any
 * depth, an object's keys included, replaced by the variable's name. So a kept
 * result still says which secret was there, never what it was. A longer value
 * is masked before a shorter one it contains, so no part of it survives. An
 * empty value masks nothing. The value given is never changed.
 *
 * A step carries a secret escaped as often as raw: inside a JSON body (a
 * newline as \n, a quote as \"), in a URL (percent encoded) or in a form body
 * (a space as +). Each of those forms is masked too, or a multi line secret
 * such as a private key would survive in the kept request body.
 */
export function maskSecrets(value: unknown, secrets: Readonly<Record<string, string>>): unknown {
  const pairs = Object.entries(secrets)
    .flatMap(([name, secret]) => [...new Set(secretForms(secret))].map((form) => [name, form] as const))
    .sort(([, a], [, b]) => b.length - a.length)
  if (pairs.length === 0) return value
  const maskText = (text: string) => pairs.reduce((masked, [name, form]) => masked.split(form).join(name), text)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskText(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, inner]) => [maskText(k), walk(inner)]))
    return v
  }
  return walk(value)
}

/** A secret as it is written raw, inside a JSON string, percent encoded in a URL, and in a form body. None for an empty one. */
function secretForms(secret: string): string[] {
  if (secret === '') return []
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]
}
