// The one lookup every route uses to turn an X-API-Key header into its source
// name (#1702). API_KEY_MAP is parsed with JSON.parse into a plain object, and a
// bracket lookup on a plain object also finds what every object inherits:
// `keyMap['constructor']` is a function, which is truthy, so a check written as
// "the map has this key" let `constructor`, `toString`, `__proto__` and friends
// through as valid keys. Only a key the map itself holds, mapped to a non-empty
// string, names a source.
export function sourceForApiKey(keyMap: Record<string, unknown>, apiKey: string): string | null {
  if (!Object.hasOwn(keyMap, apiKey)) return null
  const source = keyMap[apiKey]
  return typeof source === 'string' && source !== '' ? source : null
}
