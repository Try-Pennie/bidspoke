// The canonical name for a node's default (single) output handle, shared by the
// validators and the canvas auto-connect logic (#567, #1698). Edges loaded from a
// definition carry `source_handle ?? null`, so a legacy edge persisted without an
// explicit handle arrives as null and means "the default output".
export const DEFAULT_HANDLE = 'output'

export function normalizeHandle(handle: string | null | undefined): string {
  return handle ?? DEFAULT_HANDLE
}
