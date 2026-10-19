/**
 * A seconds setting from the environment: the default when it is absent, else a
 * positive finite number, else refused by name. An empty or mistyped value would
 * otherwise turn a count of asks or looks into NaN or Infinity and report a
 * timeout instead of the setting that caused it (L50). Every CI script reads its
 * seconds settings through this, which seconds-setting.test.ts holds them to.
 */
export function secondsSetting(raw, fallback, name) {
  if (raw === undefined) return fallback
  const value = raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of seconds, and is ${JSON.stringify(raw)}`)
  }
  return value
}
