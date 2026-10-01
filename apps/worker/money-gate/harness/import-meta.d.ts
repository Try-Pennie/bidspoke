// The two Vite import.meta features the money gate harness uses (#1704). vite is a
// dependency of vitest rather than of this package, so its client types are not on
// the type path; these declare exactly what the harness calls.
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default' }): Record<string, T>
  readonly env: Record<string, string | undefined>
}
