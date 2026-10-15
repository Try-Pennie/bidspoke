/**
 * The real dependencies of the spike (#2131): Supabase through supabase-js, the
 * database through one long lived pg connection, the Worker through a local
 * `wrangler dev` of worker/index.ts. Nothing here decides anything; spike.ts does.
 *
 * Configuration (src/cli.ts loadConfig): SUPABASE_URL, SUPABASE_SECRET_KEY and
 * SUPABASE_PUBLISHABLE_KEY from the environment, else apps/worker/.dev.vars;
 * E2E_EMAIL and E2E_PASSWORD (Org A) from the environment, else apps/web/.env.test.
 * The database connection is the standard PG* environment, which
 * `supabase db dump --dry-run --linked` prints as a temporary login: the script
 * connects ONCE, before it creates anything, and keeps that connection, because
 * the login expires five minutes after it is issued and repeated failed logins
 * ban the machine's address (memory: reference_dr_drill_temp_login_and_ban).
 *
 * Nothing here prints a key, a password or a token.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import type { SpikeConfig } from './cli.ts'
import type { CleanupOps } from './cleanup.ts'
import type { LedgerHandle } from './ledger.ts'
import { sslFor } from './ssl.ts'
import type { JoinStatus, OrgRowCounts, Received, SpikeDeps, Subscription } from './spike.ts'

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..')
const WRANGLER = path.join(REPO_ROOT, 'apps', 'worker', 'node_modules', '.bin', 'wrangler')
const WORKER_PORT = 8799
const JOIN_TIMEOUT_MS = 20_000

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String(err.message)
  return JSON.stringify(err)
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpikeConfig {
  const devVars = readEnvFile(path.join(REPO_ROOT, 'apps', 'worker', '.dev.vars'))
  const envTest = readEnvFile(path.join(REPO_ROOT, 'apps', 'web', '.env.test'))
  const pick = (name: string, ...files: Array<Record<string, string>>) => env[name] || files.map((f) => f[name]).find(Boolean) || ''
  const supabaseUrl = pick('SUPABASE_URL', devVars).replace(/\/$/, '')
  const config = {
    supabaseUrl,
    project: new URL(supabaseUrl || 'http://unset').hostname.split('.')[0],
    secretKey: pick('SUPABASE_SECRET_KEY', devVars),
    publishableKey: pick('SUPABASE_PUBLISHABLE_KEY', devVars),
    orgAEmail: pick('E2E_EMAIL', envTest),
    orgAPassword: pick('E2E_PASSWORD', envTest),
  }
  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (environment, apps/worker/.dev.vars or apps/web/.env.test)`)
  return config
}

function admin(config: SpikeConfig) {
  return createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export function liveCleanupOps(config: SpikeConfig): CleanupOps {
  const db = admin(config)
  const deleted = async (table: string, column: string, value: string): Promise<number> => {
    const { data, error } = await db.from(table).delete().eq(column, value).select(column)
    if (error) throw new Error(`${table}: ${error.message}`)
    return (data ?? []).length
  }
  return {
    findUserIdByEmail: async (email) => {
      const { data, error } = await db.from('users').select('id').eq('email', email).maybeSingle<{ id: string }>()
      if (error) throw new Error(`users: ${error.message}`)
      return data?.id ?? null
    },
    deletePublicUser: (id) => deleted('users', 'id', id),
    deleteAuthUser: async (id) => {
      const { error } = await db.auth.admin.deleteUser(id)
      if (!error) return 'removed'
      if (error.status === 404) return 'absent'
      throw new Error(`auth user: ${error.message}`)
    },
    deleteOrganization: (id) => deleted('organizations', 'id', id),
    deleteAllowlist: (email) => deleted('user_allowlist', 'email', email),
  }
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The PG* environment must be the database behind SUPABASE_URL, or the sends
 * would go to one database while the subscribers listen on another. Every kind
 * of URL is checked: hosted, local, and anything else is refused rather than
 * waved through.
 */
export function assertSameProject(config: SpikeConfig, env: NodeJS.ProcessEnv): void {
  if (!env.PGHOST) throw new Error('PGHOST is not set: export the temporary login from `supabase db dump --dry-run --linked` first')
  const urlHost = new URL(config.supabaseUrl).hostname
  const pgLocal = LOCAL_HOSTS.has(env.PGHOST)
  if (LOCAL_HOSTS.has(urlHost)) {
    if (!pgLocal) throw new Error(`SUPABASE_URL is local but PGHOST ${env.PGHOST} is not; refusing to send from a different database`)
    return
  }
  if (/\.supabase\.co$/.test(urlHost)) {
    if (pgLocal || !`${env.PGHOST} ${env.PGUSER ?? ''}`.includes(config.project)) {
      throw new Error(`PGHOST/PGUSER do not name project ${config.project}; refusing to send from a different database`)
    }
    return
  }
  throw new Error(`SUPABASE_URL host ${urlHost} is neither a hosted Supabase project nor local; refusing to guess which database it uses`)
}

async function connectDb(config: SpikeConfig, env: NodeJS.ProcessEnv): Promise<pg.Client> {
  assertSameProject(config, env)
  const client = new pg.Client({
    // The CLI's temporary login only becomes postgres through this option.
    options: (env.PGUSER ?? '').startsWith('cli_login_') ? '-c role=postgres' : undefined,
    // A hosted database is verified against Supabase's root CA and its host name.
    ssl: sslFor(env),
  })
  await client.connect()
  return client
}

async function startWorker(log: (line: string) => void, register: (closer: () => Promise<void>) => void): Promise<ChildProcess> {
  if (!existsSync(WRANGLER)) throw new Error(`wrangler not found at ${WRANGLER}; run pnpm install`)
  const child = spawn(WRANGLER, ['dev', '--config', path.join(PACKAGE_DIR, 'worker', 'wrangler.toml'), '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], {
    cwd: PACKAGE_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  register(() => {
    stopWorker(child)
    return Promise.resolve()
  })
  let output = ''
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited ${child.exitCode}: ${output.slice(-500)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`)
      if (res.ok) {
        log(`worker probe up under wrangler dev (pid ${child.pid})`)
        return child
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopWorker(child)
  throw new Error(`wrangler dev did not answer within 60 s: ${output.slice(-500)}`)
}

/** Signal the whole process group: wrangler's pid is the wrapper, workerd is its child (L321). */
function stopWorker(child: ChildProcess): void {
  if (child.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

async function subscribe(config: SpikeConfig, jwt: string, topic: string): Promise<Subscription> {
  const client = createClient(config.supabaseUrl, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  await client.realtime.setAuth(jwt)
  const received: Received[] = []
  const settled = await new Promise<{ status: JoinStatus; detail: string | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'TIMED_OUT', detail: `no answer to the join within ${JOIN_TIMEOUT_MS} ms` }), JOIN_TIMEOUT_MS)
    client
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: '*' }, (msg: { event: string; payload: Record<string, unknown> }) => {
        received.push({ event: msg.event, payload: msg.payload ?? {}, at: Date.now() })
      })
      .subscribe((status, err) => {
        clearTimeout(timer)
        resolve({ status: status as JoinStatus, detail: err ? errorText(err) : null })
      })
  })
  return {
    ...settled,
    received,
    close: async () => {
      await client.removeAllChannels()
      await client.realtime.disconnect()
    },
  }
}

async function workerSubscribe(
  config: SpikeConfig,
  jwt: string,
  topic: string,
  whenReady: () => Promise<void>,
): Promise<{ status: JoinStatus; detail: string | null; receivedAfterMs: number | null }> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${WORKER_PORT}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, jwt, topic, event: 'spike-worker', timeoutMs: 20_000 }),
    })
  } catch (err) {
    return { status: 'UNREACHABLE', detail: errorText(err), receivedAfterMs: null }
  }
  if (!res.body) return { status: 'UNREACHABLE', detail: `no body, HTTP ${res.status}`, receivedAfterMs: null }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let status: JoinStatus = 'TIMED_OUT'
  let detail: string | null = null
  let sentAt: number | null = null
  let sendError: string | null = null
  let sending: Promise<void> = Promise.resolve()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, nl)) as { event: string; status?: JoinStatus; detail?: string | null }
      buffer = buffer.slice(nl + 1)
      if (line.event === 'status' && line.status) {
        status = line.status
        detail = line.detail ?? null
        if (status === 'SUBSCRIBED' && sentAt === null) {
          sentAt = Date.now()
          // Handled here, before the next await: a send that rejects while this
          // loop waits on the network would otherwise end the process (L749).
          sending = whenReady().catch((err: unknown) => {
            sendError = `the send to the Worker's subscriber failed: ${errorText(err)}`
          })
        }
      } else if (line.event === 'message' && sentAt !== null) {
        const after = Date.now() - sentAt
        await sending
        return { status, detail, receivedAfterMs: after }
      } else if (line.event === 'timeout') {
        detail = 'subscribed but nothing arrived within 20 s'
      }
    }
  }
  await sending
  return { status, detail: sendError ?? detail, receivedAfterMs: null }
}

export async function liveDeps(
  config: SpikeConfig,
  ledger: LedgerHandle,
  marker: string,
  log: (line: string) => void,
  register: (closer: () => Promise<void>) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ deps: SpikeDeps }> {
  // Connect before anything is created, so a refused login creates nothing.
  // Each thing started is registered the moment it exists, so an interrupt
  // during the up to 60 s wrangler takes to answer still stops it (L321).
  const db = await connectDb(config, env)
  register(async () => {
    await db.end()
  })
  await startWorker(log, register)
  const service = admin(config)
  const notices: string[] = []
  db.on('notice', (msg) => notices.push(msg.message ?? ''))

  const count = async (table: string, orgId: string): Promise<number> => {
    const { count: n, error } = await service.from(table).select('*', { count: 'exact', head: true }).eq('organization_id', orgId)
    if (error) throw new Error(`${table}: ${error.message}`)
    return n ?? 0
  }

  const deps: SpikeDeps = {
    marker,
    orgA: { email: config.orgAEmail, password: config.orgAPassword },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    ledger,
    newId: () => randomUUID(),
    newPassword: () => randomBytes(24).toString('base64url'),
    signIn: async (email, password) => {
      const client = createClient(config.supabaseUrl, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      if (error || !data.session) throw new Error(`sign in as ${email}: ${error?.message ?? 'no session'}`)
      return { jwt: data.session.access_token, userId: data.user.id }
    },
    orgOfUser: async (userId) => {
      const { data, error } = await service.from('users').select('organization_id').eq('id', userId).maybeSingle<{ organization_id: string }>()
      if (error) throw new Error(`users: ${error.message}`)
      return data?.organization_id ?? null
    },
    createAllowlist: async (email) => {
      const { error } = await service.from('user_allowlist').insert({ email, added_by: marker })
      if (error) throw new Error(`user_allowlist: ${error.message}`)
    },
    createOrganization: async (org) => {
      const { error } = await service.from('organizations').insert(org)
      if (error) throw new Error(`organizations: ${error.message}`)
    },
    createAuthUser: async (email, password) => {
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error(`auth user: ${error?.message ?? 'no user returned'}`)
      return data.user.id
    },
    countOrgRows: async (orgId): Promise<OrgRowCounts> => ({
      partner_configs: await count('partner_configs', orgId),
      buyer_profiles: await count('buyer_profiles', orgId),
      workflows: await count('workflows', orgId),
    }),
    partitionExists: async () => {
      const { rows } = await db.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'realtime.messages'::regclass
             AND c.relname = 'messages_' || to_char(now() AT TIME ZONE 'utc', 'YYYY_MM_DD')
         ) AS present`,
      )
      return rows[0]?.present === true
    },
    dbSend: async (topic, event, payload) => {
      notices.length = 0
      // One round trip, as the Worker's role, with WARNINGs reported to this
      // session: realtime.send swallows its own failure into a WARNING.
      const sql = [
        'BEGIN',
        'SET LOCAL ROLE service_role',
        'SET LOCAL client_min_messages = warning',
        `SELECT realtime.send(${db.escapeLiteral(JSON.stringify(payload))}::jsonb, ${db.escapeLiteral(event)}, ${db.escapeLiteral(topic)}, true)`,
        'COMMIT',
      ].join('; ')
      try {
        await db.query(sql)
      } catch (err) {
        // A failed statement leaves the long lived connection inside an aborted
        // transaction, so every later read on it would fail too: end it here.
        await db.query('ROLLBACK').catch(() => {})
        throw new Error(`send on ${topic} failed: ${errorText(err)}`, { cause: err })
      }
      return { warnings: [...notices] }
    },
    restSend: async (topic, event, payload) => {
      const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/rest-broadcast`, {
        method: 'POST',
        body: JSON.stringify({ supabaseUrl: config.supabaseUrl, secretKey: config.secretKey, topic, event, payload }),
      })
      const answer = (await res.json()) as { status: number; body: string }
      return answer
    },
    subscribe: (label, jwt, topic) => {
      log(`joining: ${label}`)
      return subscribe(config, jwt, topic)
    },
    workerSubscribe: (jwt, topic, whenReady) => workerSubscribe(config, jwt, topic, whenReady),
    interrupt: async () => {
      process.kill(process.pid, 'SIGINT')
      return new Promise<never>(() => {})
    },
  }
  return { deps }
}
