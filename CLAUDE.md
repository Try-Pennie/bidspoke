# Bidspoke — Project Conventions

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

## Workflow Preferences
- After completing a task that has an associated TODO or planning doc, always update that doc to reflect the completed work before moving on

## PRD reference
See [PRD.md](./PRD.md) for full specs. Phase sections in PRD map to TODO.md phases.

## Dev commands
```bash
pnpm dev:web       # Next.js dev server
pnpm dev:worker    # wrangler dev
pnpm typecheck     # typecheck all packages
pnpm lint          # lint all packages
```

## GitHub
- Repo: https://github.com/Try-Pennie/bidspoke
- Commit and push after each meaningful chunk of work
- CI must pass before merging to main

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
