/**
 * The canvas toolbar's own button style (the Test button), at rest. The save
 * conflict strip's actions are drawn in it too (#2599, R2), so both read one
 * definition rather than two copies of the classes.
 */
export const TOOLBAR_BUTTON = 'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium'

/** The toolbar button's colours when it is not pressed. */
export const TOOLBAR_BUTTON_REST = 'border-gray-200 text-gray-600 hover:bg-beige'
