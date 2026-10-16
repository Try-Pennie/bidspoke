'use client'

import { useRef } from 'react'

/**
 * Stable client ids for rows the editor keeps sorted by their own values
 * (#2137). A key built from a row's value changes when the value does, so a
 * committed edit that re-sorts the list remounted the row and the person's
 * focus left the field. Here each row object gets an id the first time it is
 * seen, and an edit hands the old row's id to its replacement, so the row keeps
 * its identity however the list re-sorts. A row the editor did not make (a
 * profile loaded or put back from outside) gets a new id, which is right: it
 * is a new row on screen.
 */
export function useRowIds<T extends object>() {
  const ids = useRef(new WeakMap<T, string>())
  const next = useRef(0)
  return {
    idOf(row: T): string {
      let id = ids.current.get(row)
      if (id === undefined) {
        id = `row-${next.current++}`
        ids.current.set(row, id)
      }
      return id
    },
    /** The replacement of an edited row keeps the edited row's id. */
    carry(from: T, to: T): T {
      const id = ids.current.get(from)
      if (id !== undefined) ids.current.set(to, id)
      return to
    },
  }
}
