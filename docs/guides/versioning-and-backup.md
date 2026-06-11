# Versioning and backup

How Bidspoke versions every workflow save, how to browse and restore an earlier version, how saves are backed up to GitHub, and how duplicating a workflow carries its history. You do not have to do anything to get versioning; it happens on every save.

## Every save creates a version

When you Save a workflow on the canvas, Bidspoke does three things automatically:

1. Inserts a new row in the workflow's version history with the next version number and the full definition at that moment.
2. Invalidates the workflow's cached definition so the next run uses the new version.
3. Redeploys any Code node bundles and pushes a backup to GitHub (see below).

Version numbers increase by one per save (v1, v2, v3, ...). You can attach a short message to a save; it shows next to the version in the history.

## Browse and restore a version

Open the Version history panel from the canvas. It lists every version newest-first, each showing:

- The version number (for example "v3").
- The save message, or "No message".
- The save timestamp.

To roll back, click Restore on the version you want, then confirm. Restore is non-destructive: it does not overwrite history. Instead it takes the old definition and saves it as a new version on top. So restoring v2 while you are on v5 creates a v6 whose definition equals v2's. Your full timeline stays intact, and you can move forward or back at any time.

After a restore, the canvas loads the restored definition. Save again if you make further edits (each edit is its own new version).

## GitHub backup

On every save, Bidspoke pushes the workflow definition to a GitHub backup repository (configured at the platform level). When the push succeeds, the resulting commit SHA is recorded on that version's row (`commit_sha`). This gives you an off-platform, diffable record of every workflow definition over time.

The GitHub push runs in the background and does not block your save. If it fails (for example a transient GitHub error), the version is still created in Bidspoke; only the `commit_sha` is left empty for that version.

## Duplicating a workflow

To copy a workflow, use Duplicate on the Workflows list page. Duplicate is a server-side clone, not just a name-and-definition copy:

- It copies the full version history, preserving each version's number, timestamp, message, and commit SHA, so the clone's timeline matches the original instead of restarting at v1.
- It redeploys the clone's Code node bundles so the copy runs correctly from the start (Code node bundles are keyed per workflow).
- It mirrors the original's active state. This is safe because a fresh clone has no source assignment or webhook endpoint pointing at it, so no live traffic reaches it until you wire one up.

After duplicating, open the clone, adjust it, and save (creating its next version) before pointing any trigger at it.

## See also

- [Build a bidding workflow](./building-a-bidding-workflow.md) for the save step in context.
- [Testing and debugging](./testing-and-debugging.md) for replay and resume, which re-run past executions (distinct from restoring a definition version).
- [Overview](../concepts/overview.md) for where versioning fits among the core pieces.
