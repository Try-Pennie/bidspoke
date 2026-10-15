import type { NodeDefLike, ValidationError } from './workflow-validation'

/**
 * The shape rule for a Salesforce step's write options (#2170, phase 1 of #1680):
 * `omit_fields`, `rename_fields` and `skip_when_empty`.
 *
 * One rule, read by the canvas (validateWorkflow), the worker's save route
 * (findSalesforceConfigProblems) and the executor itself at run time, so a value
 * refused at save is exactly the value the step would refuse when it ran. A
 * malformed option is refused by name rather than ignored, because an ignored
 * omit would send a key the relay never sent and an ignored skip would PATCH an
 * empty record.
 *
 * Every step saved before these options existed carries none of them, so it is
 * untouched by this rule.
 */

/** The operations that write a record body, so the only ones omit and rename can shape. */
const BODY_OPERATIONS = new Set(['create', 'update', 'upsert'])

const fieldName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Null when the options are absent or well formed, else what is wrong, naming the option. */
export function salesforceConfigProblem(config: Record<string, unknown>): string | null {
  // The executor's own default, so a step with no operation is judged as the create it runs as.
  const operation = typeof config.operation === 'string' ? config.operation : 'create'

  if (config.omit_fields !== undefined) {
    if (!Array.isArray(config.omit_fields) || !config.omit_fields.every(fieldName)) return 'omit_fields must be a list of field names'
    if (!BODY_OPERATIONS.has(operation)) return 'omit_fields applies only to create, update and upsert'
  }

  if (config.rename_fields !== undefined) {
    const renames = config.rename_fields
    if (!isPlainObject(renames) || !Object.entries(renames).every(([from, to]) => fieldName(from) && fieldName(to))) {
      return 'rename_fields must map each field name to a new field name'
    }
    const seen = new Set<string>()
    for (const to of Object.values(renames) as string[]) {
      if (seen.has(to)) return `rename_fields renames two fields to ${to}, so one value would be lost`
      seen.add(to)
    }
    if (!BODY_OPERATIONS.has(operation)) return 'rename_fields applies only to create, update and upsert'
  }

  if (config.skip_when_empty !== undefined) {
    if (typeof config.skip_when_empty !== 'boolean') return 'skip_when_empty must be true or false'
    if (operation !== 'update') return 'skip_when_empty applies only to an update'
  }

  return null
}

/**
 * Every Salesforce step in a definition whose write options are malformed,
 * attached or not, for the worker's save route. A detached step never runs, but a
 * malformed option is wrong wherever it sits, and refusing it costs nothing.
 */
export function findSalesforceConfigProblems(nodes: readonly NodeDefLike[]): ValidationError[] {
  const problems: ValidationError[] = []
  for (const node of nodes) {
    if (node.type !== 'salesforce') continue
    const message = salesforceConfigProblem(node.config ?? {})
    if (message) problems.push({ nodeId: node.id, namespace: node.namespace, label: node.label, message })
  }
  return problems
}
