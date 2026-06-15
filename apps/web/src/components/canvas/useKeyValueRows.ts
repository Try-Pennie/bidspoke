import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type KVRow, objectToRows, rowsToObject, invalidRowIds, rowsValid } from '@/lib/key-value-rows'

// React state for a key/value editor (#96). Holds an ordered list of rows with
// stable ids so a row keeps focus while its key is edited, and two rows can
// transiently share a name without merging. Serializes back to the persisted
// object only when the rows are valid (no blank/duplicate key); an invalid set
// is held locally and reported up so Save can be blocked.
export interface UseKeyValueRows<V> {
  rows: KVRow<V>[]
  invalidIds: Set<string>
  isValid: boolean
  setKey: (id: string, key: string) => void
  setValue: (id: string, value: V) => void
  addRow: () => void
  removeRow: (id: string) => void
}

function sameObject<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => k in b && a[k] === b[k])
}

export function useKeyValueRows<V>(
  persisted: Record<string, V>,
  onPersist: (next: Record<string, V>) => void,
  emptyValue: V,
  reportValidity?: (valid: boolean) => void,
): UseKeyValueRows<V> {
  const [rows, setRows] = useState<KVRow<V>[]>(() => objectToRows(persisted))
  // The last object we emitted (or initialized from). If `persisted` differs from
  // this, it changed externally (undo / version restore) and we rebuild rows;
  // when we hold an invalid set we don't emit, so `persisted` stays equal to this
  // and our in-progress rows are preserved.
  const lastEmitted = useRef<Record<string, V>>(persisted)
  const idSeq = useRef(0)

  useEffect(() => {
    if (!sameObject(persisted, lastEmitted.current)) {
      setRows(objectToRows(persisted))
      lastEmitted.current = persisted
    }
  }, [persisted])

  const invalidIds = useMemo(() => invalidRowIds(rows), [rows])
  const isValid = invalidIds.size === 0

  useEffect(() => {
    reportValidity?.(isValid)
  }, [isValid, reportValidity])
  // Clear the block when the editor unmounts (panel closed / node deselected) —
  // an unresolved duplicate row is dropped, not persisted.
  useEffect(() => () => reportValidity?.(true), [reportValidity])

  // Apply a new row set and persist it only when valid. Persist happens outside
  // the setRows updater (a plain event-handler call), never during render.
  const commit = useCallback(
    (next: KVRow<V>[]) => {
      setRows(next)
      if (rowsValid(next)) {
        const obj = rowsToObject(next)
        lastEmitted.current = obj
        onPersist(obj)
      }
    },
    [onPersist],
  )

  const setKey = useCallback(
    (id: string, key: string) => commit(rows.map((r) => (r.id === id ? { ...r, key } : r))),
    [rows, commit],
  )

  const setValue = useCallback(
    (id: string, value: V) => commit(rows.map((r) => (r.id === id ? { ...r, value } : r))),
    [rows, commit],
  )

  const addRow = useCallback(() => {
    commit([...rows, { id: `n${idSeq.current++}`, key: '', value: emptyValue }])
  }, [rows, emptyValue, commit])

  const removeRow = useCallback((id: string) => {
    commit(rows.filter((r) => r.id !== id))
  }, [rows, commit])

  return { rows, invalidIds, isValid, setKey, setValue, addRow, removeRow }
}
