'use client'

/**
 * The one set of tabs in the app (#2137, L613), on @radix-ui/react-tabs: a
 * WAI-ARIA tablist whose arrow keys, Home and End move between tabs, each tab
 * controlling its panel. Callers never import Radix; a guard
 * (lib/__guards__/tabs-guard.test.ts) fails on any other tab, tablist or
 * tabpanel role in the app.
 *
 * Every panel stays mounted, so an edit made on one tab survives a visit to
 * another and one form can hold them all. Radix renders a force mounted panel
 * WITHOUT hiding it, so each panel here sets `hidden` itself from the tab that
 * is selected: exactly one panel is ever visible.
 *
 * Styled to the settled design (docs/design/partners-page.html, "Tabs"): plain
 * words, the open tab bold with a navy line under it. A tab may carry a problem
 * mark (ProblemMark), read to a screen reader as part of its name.
 */
import * as RadixTabs from '@radix-ui/react-tabs'
import { createContext, useContext, type ReactNode } from 'react'
import { ProblemMark } from './ProblemMark'

export interface TabItem<T extends string> {
  value: T
  label: string
  /** A field on this tab has a problem: drawn as the red mark, read as "has a problem" after the label. */
  problem?: boolean
}

const SelectedTab = createContext<string | null>(null)

export function Tabs<T extends string>({ label, value, onValueChange, items, children, className }: {
  /** What the tabs switch between, the tablist's accessible name. */
  label: string
  value: T
  onValueChange: (value: T) => void
  items: ReadonlyArray<TabItem<T>>
  /** The panels, each a TabPanel. */
  children: ReactNode
  className?: string
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={(v) => onValueChange(v as T)} className={className}>
      <RadixTabs.List aria-label={label} className="tabs-list">
        {items.map((item) => (
          <RadixTabs.Trigger key={item.value} value={item.value} className="tab">
            {item.label}
            {item.problem ? <ProblemMark label=", has a problem" className="ml-1.5" /> : null}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      <SelectedTab.Provider value={value}>{children}</SelectedTab.Provider>
    </RadixTabs.Root>
  )
}

/** One tab's panel. Always mounted; hidden unless its tab is selected. */
export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const selected = useContext(SelectedTab)
  return (
    <RadixTabs.Content value={value} forceMount hidden={selected !== value} className={`tab-panel ${className ?? ''}`.trim()}>
      {children}
    </RadixTabs.Content>
  )
}
