// PR0 of the partners page redesign (#2131): prove Supabase broadcast from the
// database on this project, against the live project, with a throwaway Org B.
//
//   node scripts/realtime-spike/run.mjs --i-have-approval --ledger <path> [--samples N] [--self-interrupt]
//   node scripts/realtime-spike/run.mjs --cleanup <ledger>
//
// Refuses to create anything without --i-have-approval (decision 1 of #2114).
// Writes the ledger before creating anything; SIGINT and SIGTERM clean up from
// it and exit; the normal path cleans up too. The full sequence, the
// configuration it reads and the result it writes are in
// docs/adr/0012-partner-page-live-channel.md. The code is in
// packages/realtime-spike, where its tests are; this file only starts it.
//
// Needs Node 22.18 or later (TypeScript type stripping) and `pnpm install`.
import { main } from '../../packages/realtime-spike/src/cli.ts'
import { liveWiring } from '../../packages/realtime-spike/src/wiring.ts'

const code = await main(process.argv.slice(2), liveWiring())
// Realtime sockets and timers would otherwise hold the process open.
process.exit(code)
