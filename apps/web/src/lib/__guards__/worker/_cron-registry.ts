/**
 * The heartbeat registry's jobs of OTHER Workers (#1949), shared by the two cron
 * guards (cron-jobs-all-stamped, worker-cron-wiring-guard). A job declaring
 * `worker` is another Worker's cron watched from here, because the watchdog must
 * not depend on the Worker it watches (L71); its schedule is in that Worker's
 * config and its stamps are written where it reaches this Worker.
 */

/**
 * Where a job of ANOTHER Worker is stamped (#1949). The ops Worker's minute cron
 * is watched from here (L71), and its stamps arrive through the OpsGateway
 * entrypoint, which writes them in lib/ops-gateway.ts, not in index.ts. A worker
 * named here with no stamping source is a job nothing can stamp.
 */
export const STAMPED_IN: Record<string, string> = {
  'bidspoke-worker-ops': 'lib/ops-gateway.ts',
}

/** Each registered job's `worker`, for the jobs that declare one (another Worker's cron). */
export function jobWorkers(registrySource: string): Map<string, string> {
  const start = registrySource.indexOf('export const CRON_JOBS')
  const end = registrySource.indexOf('\n]', start)
  const out = new Map<string, string>()
  for (const entry of registrySource.slice(start, end).split(/\n {2}\{\n/).slice(1)) {
    const id = /^\s+id: '([a-z0-9-]+)',/m.exec(entry)?.[1]
    const worker = /^\s+worker: '([a-z0-9-]+)',/m.exec(entry)?.[1]
    if (id && worker) out.set(id, worker)
  }
  return out
}

