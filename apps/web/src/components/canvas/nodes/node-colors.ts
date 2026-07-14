/**
 * The one place a node type's color is decided. Sits beside registry.tsx, the
 * other "every node type must be listed here" chokepoint, and for the same
 * reason: the minimap's color list used to be a hand-copied duplicate of the
 * card icon colors, and it silently fell six types behind (#660, #661).
 *
 * Two halves because the two surfaces cannot share one representation: the cards
 * render a Tailwind utility class, the minimap draws raw SVG rects that can only
 * take a hex. node-colors.test.ts pins the halves to each other, so a card and
 * its minimap dot cannot drift into different colors.
 *
 * NOTE: this file must stay under src/components — Tailwind's `content` globs
 * (tailwind.config.ts) cover src/app and src/components only. Moved to src/lib
 * and the class literals below stop being scanned, get purged from the CSS
 * bundle, and every node icon silently renders colorless. Nothing in the type
 * system or the test suite would catch that; it is a CSS build-time behavior.
 */
export interface NodeColor {
  /** Tailwind text-color utility for the card + palette icon. */
  icon: string
  /** Same color as a hex, for the minimap's SVG rects. */
  hex: string
}

export const NODE_TYPE_COLOR: Record<string, NodeColor> = {
  trigger:        { icon: 'text-p-blue-dark', hex: '#1B72BA' },
  filter:         { icon: 'text-p-blue-dark', hex: '#1B72BA' },
  branch:         { icon: 'text-purple-500',  hex: '#a855f7' },
  branch_end:     { icon: 'text-purple-500',  hex: '#a855f7' },
  code:           { icon: 'text-amber-500',   hex: '#f59e0b' },
  response:       { icon: 'text-green-600',   hex: '#16a34a' },
  exit:           { icon: 'text-red-600',     hex: '#dc2626' },
  transform:      { icon: 'text-orange-500',  hex: '#f97316' },
  webhook:        { icon: 'text-teal-500',    hex: '#14b8a6' },
  parallel:       { icon: 'text-slate-500',   hex: '#64748b' },
  parallel_end:   { icon: 'text-slate-500',   hex: '#64748b' },
  bid_group:      { icon: 'text-rose-500',    hex: '#f43f5e' },
  constants:      { icon: 'text-indigo-500',  hex: '#6366f1' },
  salesforce:     { icon: 'text-blue-500',    hex: '#3b82f6' },
  data_store:     { icon: 'text-cyan-500',    hex: '#06b6d4' },
  latency_gate:   { icon: 'text-orange-500',  hex: '#f97316' },
  achieve_offers: { icon: 'text-violet-500',  hex: '#8b5cf6' },
  // Retired (#645), still executable and still in NODE_TYPES, so it still has to
  // draw. Matches the GenericNode card it falls back to.
  partner_bid:    { icon: 'text-slate-400',   hex: '#94a3b8' },
}

/** Gray for a type we do not know. A stray or future node still draws. */
export const UNKNOWN_NODE_COLOR = '#9ca3af'

/**
 * Minimap fill for a node type. Every type in NODE_TYPES resolves; the fallback
 * is only for a definition carrying something this build has never heard of.
 */
export function minimapNodeColor(type: string): string {
  return NODE_TYPE_COLOR[type]?.hex ?? UNKNOWN_NODE_COLOR
}

/** Tailwind icon class for a node type, for the cards and the palette. */
export function nodeIconClass(type: string): string {
  return NODE_TYPE_COLOR[type]?.icon ?? 'text-slate-400'
}
