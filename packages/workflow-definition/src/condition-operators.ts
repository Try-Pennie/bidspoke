/**
 * The one list of condition operators (#2588).
 *
 * A condition is `{ field, operator, value }`, used by Filter, Branch, edge
 * conditions and Bid Group tier gates. Until #2588 its operators were kept by
 * hand in four places (the web and worker `EdgeCondition` unions, the rule
 * builder's lists and the worker's `evaluateCondition` switch) plus two label
 * lists, and nothing made them agree. Now:
 *
 * - `ConditionOperator` is the type both apps' `EdgeCondition.operator` uses.
 * - `CONDITION_OPERATOR_SPECS` is a Record over that type, so an operator added
 *   to the list without its labels and value kind does not compile.
 * - The worker's switch ends in `assertNever`, so an operator added here without
 *   a case does not compile either.
 * - `RULE_BUILDER_OPERATORS`, `SIMPLE_FILTER_OPERATORS` and the spec labels are
 *   the dropdown and card lists: the rule builder (RuleBuilder.tsx), the simple
 *   Filter condition (ConfigPanel.tsx) and the Filter card's summary
 *   (filter-condition.ts) all read them, and hold no copy of their own.
 *   A label is one vocabulary: the rule builder dropdown and every condition
 *   summary show the same words (Dan, 2026-10-21, settled in
 *   docs/design/lead-validation-node.html, decisions D9 to D11).
 *
 * Every live definition stores one of these spellings, so an operator is never
 * renamed or removed, only added.
 */
import { ROOT_NAMESPACES, type RootNamespace } from '@bidspoke/references'

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'in_array',
  'not_in_array',
  'is_true',
  'is_false',
  'is_null',
  'is_not_null',
  'exists',
  'not_exists',
  // Added for the lead validation node (#934). Both read only the field.
  'has_letter',
  'not_blank',
] as const

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

/**
 * What the value side of a condition holds, which decides how the rule builder
 * stores what is typed and whether it shows a value box at all.
 *
 * - `none`: the operator reads only the field; any stored value is ignored.
 * - `scalar`: compared for equality, numeric looking input stored as a number.
 * - `number`: compared numerically; a literal or a `steps.`/`trigger.`/`env.`
 *   reference resolved at run time.
 * - `text`: a substring.
 * - `list`: an array, or a reference to one.
 */
export type ConditionValueKind = 'none' | 'scalar' | 'number' | 'text' | 'list'

export interface ConditionOperatorSpec {
  /** Compact label: the rule builder dropdown and the Filter card summary. */
  label: string
  /** Spelled out label: the simple Filter condition dropdown. */
  words: string
  valueKind: ConditionValueKind
  /**
   * Offered by the simple Filter condition dropdown (one condition, no rule
   * builder). The ten it offered before #2588; the rule builder offers all.
   */
  simpleFilter: boolean
}

export const CONDITION_OPERATOR_SPECS: Readonly<Record<ConditionOperator, ConditionOperatorSpec>> = {
  eq: { label: '=', words: 'equals', valueKind: 'scalar', simpleFilter: true },
  neq: { label: '≠', words: 'does not equal', valueKind: 'scalar', simpleFilter: true },
  gt: { label: '>', words: 'greater than', valueKind: 'number', simpleFilter: true },
  gte: { label: '≥', words: 'greater than or equal', valueKind: 'number', simpleFilter: true },
  lt: { label: '<', words: 'less than', valueKind: 'number', simpleFilter: true },
  lte: { label: '≤', words: 'less than or equal', valueKind: 'number', simpleFilter: true },
  contains: { label: 'contains', words: 'contains', valueKind: 'text', simpleFilter: true },
  not_contains: { label: 'not contains', words: 'does not contain', valueKind: 'text', simpleFilter: true },
  in_array: { label: 'in list', words: 'is in list', valueKind: 'list', simpleFilter: false },
  not_in_array: { label: 'not in list', words: 'is not in list', valueKind: 'list', simpleFilter: false },
  is_true: { label: 'is true', words: 'is true', valueKind: 'none', simpleFilter: false },
  is_false: { label: 'is false', words: 'is false', valueKind: 'none', simpleFilter: false },
  is_null: { label: 'is null', words: 'is null', valueKind: 'none', simpleFilter: false },
  is_not_null: { label: 'is not null', words: 'is not null', valueKind: 'none', simpleFilter: false },
  exists: { label: 'exists', words: 'exists', valueKind: 'none', simpleFilter: true },
  not_exists: { label: 'not exists', words: 'does not exist', valueKind: 'none', simpleFilter: true },
  has_letter: { label: 'contains a letter', words: 'contains a letter', valueKind: 'none', simpleFilter: false },
  not_blank: { label: 'is not empty', words: 'is not empty', valueKind: 'none', simpleFilter: false },
}

const OPERATOR_SET: ReadonlySet<string> = new Set(CONDITION_OPERATORS)

/** True for a listed operator. Stored config is untrusted, so this is a Set lookup, never a bracket lookup that finds `constructor`. */
export function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === 'string' && OPERATOR_SET.has(value)
}

export function operatorTakesValue(op: ConditionOperator): boolean {
  return CONDITION_OPERATOR_SPECS[op].valueKind !== 'none'
}

export interface OperatorOption {
  value: ConditionOperator
  label: string
}

/** Every operator, in list order, with its compact label. */
export const RULE_BUILDER_OPERATORS: readonly OperatorOption[] = CONDITION_OPERATORS.map((value) => ({
  value,
  label: CONDITION_OPERATOR_SPECS[value].label,
}))

/** The simple Filter condition's options, with spelled out labels. */
export const SIMPLE_FILTER_OPERATORS: readonly OperatorOption[] = CONDITION_OPERATORS
  .filter((op) => CONDITION_OPERATOR_SPECS[op].simpleFilter)
  .map((value) => ({ value, label: CONDITION_OPERATOR_SPECS[value].words }))

export const VALUE_LESS_OPERATORS: ReadonlySet<ConditionOperator> = new Set(
  CONDITION_OPERATORS.filter((op) => !operatorTakesValue(op)),
)

// The condition resolver (resolveField in apps/worker/src/engine/graph.ts) reads
// `env`, `steps` and `trigger`, and has no branch for `execution`: a value naming
// it resolves to undefined. Excluding it here keeps a condition from treating as
// a reference something it cannot read. The worker's graph test pins both halves,
// so teaching resolveField `execution` fails that test until this is lifted.
const NOT_READ_BY_CONDITIONS: ReadonlySet<RootNamespace> = new Set<RootNamespace>(['execution'])

export const CONDITION_REFERENCE_ROOTS: readonly RootNamespace[] = ROOT_NAMESPACES.filter(
  (root) => !NOT_READ_BY_CONDITIONS.has(root),
)

/**
 * True when a condition's value side names a run time value rather than holding
 * a literal: a string starting with one of CONDITION_REFERENCE_ROOTS and a dot.
 * `in_array`, `not_in_array` and the numeric operators resolve such a value; the
 * others compare it as text.
 */
export function isConditionValueReference(value: unknown): value is string {
  return typeof value === 'string' && CONDITION_REFERENCE_ROOTS.some((root) => value.startsWith(`${root}.`))
}
