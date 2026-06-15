// Issue #100: source names are interpolated into API paths and used as
// trigger.source. The create form only lowercased + replaced whitespace, so
// URL-breaking characters (/, %, ?, #, &) passed through; such a source could be
// created but then never deleted/assigned, because the path interpolations had no
// encodeURIComponent. Enforce the promised charset (lowercase, numbers,
// underscores) at the source. Mirror of the worker's POST /api/sources sanitizer.
export function sanitizeSourceName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}
