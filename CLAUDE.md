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
