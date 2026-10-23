import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * Supabase (#2337, phase 7 of #1689): one project's service key.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted):
 *   supabase-insert-row   21 steps
 *   supabase-select-row    5
 *   supabase-update-row    2
 * in 21 workflows, every one against one project, blicjwldjfjubbukxatn (not the
 * bidding project). Code steps using the SDK (@supabase/supabase-js or
 * this.supabase.$auth) are in 20 workflow files; they port as code steps on
 * this connection, not as these actions. Each action is one PostgREST request,
 * as Pipedream's supabase-js call was (PipedreamHQ/pipedream
 * components/supabase, at commit b7d67916).
 *
 * The connection is the key (`{ service_key }`, the static key minter's
 * supabase placement, sent as apikey and as a bearer token) and the project it
 * belongs to (`project_url`, the Project URL or the bare ref,
 * schema/supabase-project.ts), whose one host connectionFetch lets it reach.
 * A key is project scoped, so a key that answers on the declared project's
 * host is that project's: verify proves it with a free GET there, and refuses
 * the bidding and ops projects (apps/worker src/ops/connections/supabase-service.ts).
 */

const name = (key: string, required = true): ActionArgument => ({ key, type: 'text', required, allowsVariables: false, parseJson: false })
const value = (key: string, required: boolean): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string, required: boolean): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: true })

export const SUPABASE_INSERT_ROW_V1: ActionSchema = {
  key: 'supabase.insert-row',
  name: 'Insert row',
  version: 1,
  // data: one row as an object, or a list of rows, inserted in one statement.
  arguments: [name('table'), json('data', true)],
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'A repeat inserts a second row unless the table has a unique key the row repeats, which Bidspoke cannot know, so after an uncertain outcome a person decides.',
}

export const SUPABASE_SELECT_ROW_V1: ActionSchema = {
  key: 'supabase.select-row',
  name: 'Select rows',
  version: 1,
  arguments: [
    name('table'),
    // column, filter and value go together or not at all, as in Pipedream.
    name('column', false),
    // equalTo, notEqualTo, greaterThan, greaterThanOrEqualTo, lessThan, lessThanOrEqualTo, patternMatch, patternMatchCaseInsensitive.
    name('filter', false),
    value('value', false),
    name('order_by'),
    // ascending or descending; descending when blank, as Pipedream read it.
    name('sort_order', false),
    // 1 to 1,000 rows, 20 when blank, as Pipedream's default.
    json('max', false),
  ],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'It reads and changes nothing.',
}

export const SUPABASE_UPDATE_ROW_V1: ActionSchema = {
  key: 'supabase.update-row',
  name: 'Update rows',
  version: 1,
  // The rows whose column equals the value get the data's columns.
  arguments: [name('table'), name('column'), value('value', true), json('data', true)],
  sideEffect: true,
  idempotent: false,
  idempotentBecause:
    'A Postgres UPDATE fires the table\'s triggers every time it runs, and a database Bidspoke does not know may keep a count, an audit row or a timestamp there, so after an uncertain outcome a person decides, even when the values are the same.',
}

export const SUPABASE_SERVICE: ServiceSchema = {
  key: 'supabase',
  name: 'Supabase',
  actions: [SUPABASE_INSERT_ROW_V1, SUPABASE_SELECT_ROW_V1, SUPABASE_UPDATE_ROW_V1],
  // The static key minter reads `service_key` from the login (minters/static-key.ts,
  // supabase); the ops Supabase entry reads `project_url` from the target.
  connection: {
    tile: 'A project\'s service key',
    auth: 'static_key',
    fields: [
      { key: 'project_url', label: 'Project URL', input: 'text', required: true, target: 'project_url' },
      { key: 'service_key', label: 'Service key', input: 'secret', required: true, login: 'service_key' },
    ],
  },
}
