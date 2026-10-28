# Pipedream converter

Turns one workflow of a Pipedream export into a draft Bidspoke can build from
(#1695, plan Phase 9 in discussion #1684). Node only: it is run from the command
line and, later, by the MCP tool, and is never bundled into a Worker or the web app.

```bash
pnpm run convert -- <export dir> <workflow id>
```

It prints the draft as JSON and writes nothing. It reads the workflow's row of
`porting.pipedream_inventory` with one GET, using `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` from the environment or `apps/worker/.dev.vars`.

## What it does now (9.1, the skeleton)

- Reads the export through `@bidspoke/porting-evidence` (`readExport`), never a
  second reader.
- Refuses any export that is not the newest snapshot the inventory records for
  the workflow (Hard Rule 7), by name: `snapshot_not_recorded`,
  `snapshot_older_than_recorded`, `snapshot_newer_than_recorded`,
  `snapshot_differs_from_recorded`, `absent_from_newest_export`. The rule and why
  each case refuses are in `src/snapshot.ts`.
- Stamps the snapshot's sha256, export time and file on the draft.
- Lists every trigger and every step (the main pipeline, then each deployment)
  with its kind and its pinned `uses` key and version.
- Parses each code step and private component with porting-evidence's
  `parseStepCode` (recast over @babel/parser, never regex, #17) and records
  whether it parsed.
- Names in `unconverted` everything it cannot read: a code step that does not
  parse (with its line), a step of no known shape, a trigger of no known type.

A draft carries names, keys and versions only, never code or prop values.

## What comes next (#1695)

- The component source resolver (D1): read each registry step's and trigger's
  pinned source from PipedreamHQ/pipedream at the commit whose version matches,
  and record that sha on the draft.
- Mapping (9.2): triggers, code steps through the shim, private components,
  registry actions onto the catalogue, absent props as the pinned defaults,
  control flow, error handlers, step namespaces, settings to the checklist, and
  the lane. Also the two open questions in the issue: what happens to disabled
  steps, and code that reads `this.<app>.$auth`.
- Output (9.3): a draft that passes `validateDefinition`, written through the
  `/api` routes, with reruns updating through `pipedream_workflow_map`.
- The MCP tool that runs the converter.
