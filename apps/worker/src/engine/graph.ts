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
  const results = groups.map((g) => evaluateGroup(g, ctx))
  return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

function evaluateGroup(group: ConditionGroup, ctx: ExecutionContext): boolean {
  const results = group.conditions.map((c) => evaluateCondition(c, ctx))
  return group.logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

function evaluateCondition(
  condition: { field: string; operator: string; value?: unknown },
  ctx: ExecutionContext
): boolean {
  const actual = resolveField(condition.field, ctx)
  switch (condition.operator) {
    case 'eq':       return actual === condition.value
    case 'neq':      return actual !== condition.value
    case 'gt':       return (actual as number) > (condition.value as number)
    case 'gte':      return (actual as number) >= (condition.value as number)
    case 'lt':       return (actual as number) < (condition.value as number)
    case 'lte':      return (actual as number) <= (condition.value as number)
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
      return Array.isArray(arr) && arr.includes(actual)
    }
    case 'not_in_array': {
      const arr = resolveValueOrLiteral(condition.value, ctx)
      return Array.isArray(arr) && !arr.includes(actual)
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

function resolveField(field: string, ctx: ExecutionContext): unknown {
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
