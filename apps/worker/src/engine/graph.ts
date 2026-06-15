import type { NodeDefinition, EdgeDefinition, ExecutionContext, ConditionGroup } from '../types'

// Find the entry node: follow the trigger edge if present, otherwise find the node with no incoming edges from other nodes
export function findEntryNode(nodes: NodeDefinition[], edges: EdgeDefinition[]): NodeDefinition {
  const triggerEdge = edges.find((e) => e.source === 'trigger')
  if (triggerEdge) {
    const entry = nodes.find((n) => n.id === triggerEdge.target)
    if (entry) return entry
  }
  // Fallback for workflows without an explicit trigger edge
  const nodeIds = new Set(nodes.map((n) => n.id))
  const targets = new Set(edges.filter((e) => nodeIds.has(e.source)).map((e) => e.target))
  const entry = nodes.find((n) => !targets.has(n.id) && !n.parent)
  if (!entry) throw new Error('No entry node found in workflow graph')
  return entry
}

// Find all outgoing edges from a node
export function outgoingEdges(nodeId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.source === nodeId)
}

// Find a node by id
export function findNode(id: string, nodes: NodeDefinition[]): NodeDefinition | undefined {
  return nodes.find((n) => n.id === id)
}

// Evaluate a conditional edge against the current execution context
export function evaluateEdge(edge: EdgeDefinition, ctx: ExecutionContext): boolean {
  if (!edge.condition) return true
  return evaluateConditionGroups(edge.condition.groups, edge.condition.logic, ctx)
}

export function evaluateConditionGroups(
  groups: ConditionGroup[],
  logic: 'AND' | 'OR',
  ctx: ExecutionContext
): boolean {
  // Fail closed: a condition with no groups has nothing to match, so it must NOT
  // match. Otherwise AND-of-nothing evaluates true and an unconfigured branch arm
  // routes every lead down it (#93). Filters are unaffected — filter.ts guards on
  // groups.length before calling, so its intentional "no rules = pass" still holds.
  if (groups.length === 0) return false
  const results = groups.map((g) => evaluateGroup(g, ctx))
  return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

function evaluateGroup(group: ConditionGroup, ctx: ExecutionContext): boolean {
  // Same fail-closed rule for an empty conditions list (#93).
  if (group.conditions.length === 0) return false
  const results = group.conditions.map((c) => evaluateCondition(c, ctx))
  return group.logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

// Equality for eq/neq. Rule-builder config values always arrive as strings
// ("0", "true", "WI"), while the resolved field is its real type (number 0,
// boolean true). A strict === therefore never matched a numeric/boolean field
// against its string config — e.g. `mutate_bes.output (number 0) != "0"` wrongly
// evaluated true and fired the arm. Coerce the string config by the actual
// value's type, then fall back to a string compare so same-typed values and
// plain strings still work.
function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (typeof actual === 'number' && typeof expected === 'string' && expected.trim() !== '') {
    return actual === Number(expected)
  }
  if (typeof actual === 'boolean' && typeof expected === 'string') {
    return String(actual) === expected
  }
  if (actual === null || actual === undefined) return false
  return String(actual) === String(expected)
}

// Numeric comparison for gt/gte/lt/lte. Both sides are coerced to Number first:
// config values arrive as strings, and the field may also be a numeric string
// (e.g. "9"). Comparing two strings with > would sort lexicographically — "9" >
// "10" is true — so we must compare as numbers. Non-numeric operands yield NaN,
// which makes every comparison false (the safe default for a malformed rule).
function numericCompare(actual: unknown, expected: unknown, cmp: (a: number, b: number) => boolean): boolean {
  const a = Number(actual)
  const b = Number(expected)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return cmp(a, b)
}

function evaluateCondition(
  condition: { field: string; operator: string; value?: unknown },
  ctx: ExecutionContext
): boolean {
  const actual = resolveField(condition.field, ctx)
  // A missing operator defaults to equality — the config UI shows 'equals' as
  // the default in its dropdown, so an un-touched condition (operator never
  // written) must behave as equals rather than throw. Matches the UI default.
  switch (condition.operator || 'eq') {
    case 'eq':       return valuesEqual(actual, condition.value)
    case 'neq':      return !valuesEqual(actual, condition.value)
    case 'gt':       return numericCompare(actual, condition.value, (a, b) => a > b)
    case 'gte':      return numericCompare(actual, condition.value, (a, b) => a >= b)
    case 'lt':       return numericCompare(actual, condition.value, (a, b) => a < b)
    case 'lte':      return numericCompare(actual, condition.value, (a, b) => a <= b)
    case 'contains': return String(actual).includes(String(condition.value))
    case 'not_contains': return !String(actual).includes(String(condition.value))
    case 'is_true':  return actual === true
    case 'is_false': return actual === false
    case 'exists':   return actual !== undefined && actual !== null
    case 'not_exists': return actual === undefined || actual === null
    case 'is_null':  return actual === null
    case 'is_not_null': return actual !== null
    case 'in_array': {
      const arr = resolveValueOrLiteral(condition.value, ctx)
      return Array.isArray(arr) && arr.some((el) => valuesEqual(actual, el))
    }
    case 'not_in_array': {
      const arr = resolveValueOrLiteral(condition.value, ctx)
      return Array.isArray(arr) && !arr.some((el) => valuesEqual(actual, el))
    }
    default: {
      // Surface unhandled operators instead of silently returning false.
      // A new operator added to the type union but not to this switch would
      // otherwise quietly evaluate every condition as false — branches just
      // wouldn't fire and the user would have no idea why.
      const op = (condition as { operator: string }).operator
      throw new Error(`Unknown condition operator: ${JSON.stringify(op)}`)
    }
  }
}

// For value sides that can either be a literal or a path reference
// (e.g. in_array operator pointing at `steps.constants.output.states`).
// Resolves as a path when the string starts with steps./trigger./env.;
// otherwise returns the value unchanged so JSON literals still work.
function resolveValueOrLiteral(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value !== 'string') return value
  if (/^(steps\.|trigger\.|env\.)/.test(value)) return resolveField(value, ctx)
  return value
}

export function resolveField(field: string, ctx: ExecutionContext): unknown {
  // Coalesce / fallback: "a ?? b" resolves to the first operand that isn't
  // null/undefined — lets a condition read whichever of two steps ran (e.g. a
  // duplicated node). Mirrors the same syntax in `{{...}}` templates.
  if (field.includes('??')) {
    for (const part of field.split('??')) {
      const v = resolveField(part.trim(), ctx)
      if (v !== null && v !== undefined) return v
    }
    return undefined
  }
  const parts = field.split('.')
  if (parts[0] === 'trigger') {
    return getPath(ctx.trigger, parts.slice(1))
  }
  if (parts[0] === 'steps' && parts[1]) {
    // Tolerate explicit `.output` — matches the copy-path format from the JSON tree
    const pathParts = parts[2] === 'output' ? parts.slice(3) : parts.slice(2)
    return getPath(ctx.steps[parts[1]]?.output, pathParts)
  }
  if (parts[0] === 'env') {
    return ctx.env[parts[1]]
  }
  return undefined
}

function getPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    // Array index notation: "list[0]" or bare "[0]"
    const arrMatch = part.match(/^([^[]*)\[(\d+)\]$/)
    if (arrMatch) {
      const key = arrMatch[1]
      const idx = parseInt(arrMatch[2], 10)
      const base = key ? (cur as Record<string, unknown>)[key] : cur
      cur = Array.isArray(base) ? base[idx] : undefined
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}
