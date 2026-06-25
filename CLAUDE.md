# Bidspoke — Project Conventions

@TODO.md

## Design
@.impeccable.md

## Stack
- **Frontend:** Next.js 14 (App Router) on Cloudflare Pages — `apps/web`
- **Worker:** Cloudflare Workers with Hono — `apps/worker`
- **Database/Auth:** Supabase (Postgres + Auth + Realtime)
- **Package manager:** pnpm workspaces
- **Language:** TypeScript everywhere, strict mode

## Monorepo
- `apps/web` — Next.js frontend
- `apps/worker` — Cloudflare Worker (API + execution engine)

## Key conventions
- All Worker routes are in `apps/worker/src/index.ts`, handlers in `src/routes/`
- Durable Objects live in `src/durable-objects/`
- Node type implementations live in `src/nodes/`
- All DB access goes through Supabase client, never raw SQL from the Worker
- RLS is enforced at the DB level — don't replicate org scoping in application code
- Secrets are injected via Cloudflare Worker secrets, never committed

## Code Standards
- Prefer TypeScript over JavaScript for all new code
- Use straight quotes (`'` and `"`) in all string literals — never smart/curly quotes
- No em dashes in copy or UI text — use periods, colons, or commas instead

## Codebase Navigation
A graphify knowledge graph of this codebase lives in `graphify-out/`. Before reading codebase files to answer a question or explore architecture, consult the graph first:
1. Grep `graphify-out/obsidian/` community files for relevant terms to identify which files are involved
2. Or grep `graphify-out/graph.json` for node labels/IDs
3. Then read only the specific files the graph points to

This avoids broad directory walks and full-file reads. Skip the graph only when you already know the exact file path.

## Workflow Preferences
- After completing a task that has an associated TODO or planning doc, always update that doc to reflect the completed work before moving on
- Never use the `open` command to preview files — triggers Island browser unexpectedly

## PRD reference
See [PRD.md](./PRD.md) for full specs. Phase sections in PRD map to TODO.md phases.

## Dev commands
```bash
pnpm dev:web       # Next.js dev server
pnpm dev:worker    # wrangler dev
pnpm typecheck     # typecheck all packages
pnpm lint          # lint all packages
```

> **pnpm gotcha:** Always use `pnpm run <script>`, never `pnpm <script>` — `pnpm deploy` hits the pnpm built-in, not the project script.

## GitHub
- Repo: https://github.com/Try-Pennie/bidspoke
- Commit and push after each meaningful chunk of work
- CI must pass before merging to main
- Always commit `pnpm-lock.yaml` in the same commit as `package.json` changes — CI uses frozen-lockfile and will break otherwise

## Database migrations
Migrations must be **backward-compatible (expand/contract)** so schema and code can deploy in either order without a window where prod code and schema disagree. In short: additive-only in a single migration (add nullable/defaulted columns, tables, indexes); never rename or drop in the same release that starts using the change — split renames/drops across two releases (expand + dual-write, then contract later). The deploy pipeline only CHECKS migrations are applied; you apply them by hand with `supabase db push`. Full rules + deployment runbook: [docs/adr/0007-expand-contract-migrations.md](./docs/adr/0007-expand-contract-migrations.md).

## Worker secrets (production)
These must be set via `wrangler secret put <NAME> --name bidspoke-worker`. Never committed to git.

| Secret | Purpose |
|--------|---------|
| `SUPABASE_SECRET_KEY` | Supabase service role key |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token for syncing partner secrets |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `API_KEY_MAP` | JSON map of webhook API keys to source names |
| `SECRET_ENCRYPTION_KEY` | AES-GCM key for encrypting env var secret values (enables reveal in UI) |

### Rotating `SECRET_ENCRYPTION_KEY`
Generate: `openssl rand -base64 32`, then `wrangler secret put SECRET_ENCRYPTION_KEY --name bidspoke-worker`.

**Warning:** rotating this key breaks reveal for any secrets created before the rotation. Users will see "rotate to enable reveal" until they re-save the affected env vars with a new value.
