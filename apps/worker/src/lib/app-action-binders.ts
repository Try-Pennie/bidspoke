/**
 * Who bound each app_action step to its connection (#2339).
 *
 * Dan decided on 2026-10-23 (recorded on #2338) that a person's own account may
 * be used only by its owner, so no workflow can send email as someone else. The
 * ops executor (apps/worker src/ops/app-action.ts) therefore runs an own account
 * step only when the step's `config.boundBy` is the connection's owner.
 *
 * The stamp is the server's, written on every definition write by writeWorkflow:
 *  - a step whose connection is unchanged from the stored definition (the same
 *    node id, still an app_action, the same connection) keeps the stored stamp,
 *    whoever saves the rest of the workflow;
 *  - any other step (new, its connection changed, or a stored stamp that is not
 *    a user id) is stamped with the person writing it.
 * A boundBy the client sent is never kept: an unchanged step takes the stored
 * value and every other step the writer's. A duplicate has no stored definition
 * of its own, so every step of the copy is stamped with whoever duplicated it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type NodeLike = { id?: unknown; type?: unknown; config?: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function storedSteps(stored: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!isRecord(stored) || !Array.isArray(stored.nodes)) return out
  for (const n of stored.nodes as NodeLike[]) {
    if (isRecord(n) && n.type === 'app_action' && typeof n.id === 'string' && isRecord(n.config)) out.set(n.id, n.config)
  }
  return out
}

/** The definition with every app_action step's boundBy set by the rule above. Never changes its arguments. */
export function stampAppActionBinders(next: unknown, stored: unknown, actorId: string): unknown {
  if (!isRecord(next) || !Array.isArray(next.nodes)) return next
  const before = storedSteps(stored)
  const nodes = (next.nodes as unknown[]).map((n) => {
    if (!isRecord(n) || n.type !== 'app_action' || !isRecord(n.config)) return n
    const prior = typeof n.id === 'string' ? before.get(n.id) : undefined
    const kept = prior !== undefined && prior.connection === n.config.connection && typeof prior.boundBy === 'string' && UUID.test(prior.boundBy)
    return { ...n, config: { ...n.config, boundBy: kept ? prior.boundBy : actorId } }
  })
  return { ...next, nodes }
}
