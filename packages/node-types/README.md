# @bidspoke/node-types

The one list of node types a saved definition can carry (`NODE_TYPES`,
`NodeType`), the traits each has (`NODE_TRAITS`: network, dispatch or storage,
walker only, synthesizes attempts, references partners, static handles,
executor file) and `assertNever` (#1411). Both apps re-export it from their old
paths (`apps/worker/src/types.ts`, `apps/web/src/types/workflow.ts`).

## Adding a node type

Add it here with its traits. The compiler then names every switch and record
that must handle it (`executeNode`, save validation, colours, cards, heights),
and the coverage tests name the palette, preview, config panel, shadow
exemption, changelog glossary and similar fallback placements.
