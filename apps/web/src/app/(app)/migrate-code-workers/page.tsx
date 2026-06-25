'use client'

export const runtime = 'edge'

import { useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Loader2, CheckCircle, XCircle, ArrowRight } from 'lucide-react'

interface Result {
  id: string
  name: string
  status: string
  error?: string
  node_count?: number
}

interface Response {
  migrated: number
  skipped: number
  errored: number
  results: Result[]
}

export default function MigrateCodeWorkersPage() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.admin.migrateCodeWorkers()
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <NavLayout>
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-2xl font-semibold text-graphite">Migrate code workers</h1>
        <p className="mt-2 text-sm text-gray-600">
          Force-redeploys every active workflow&apos;s code nodes under the new bundled layout
          (one dispatched worker per workflow instead of one per code node). Safe to run
          multiple times. Run once after shipping 4B.
        </p>

        <div className="mt-6">
          <button
            onClick={run}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#155E99] disabled:opacity-50"
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Migrating...
              </>
            ) : (
              <>
                Run migration
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-6 space-y-4">
            <div className="flex gap-6 text-sm">
              <div>
                <span className="font-medium text-green-700">{result.migrated}</span>{' '}
                <span className="text-gray-600">migrated</span>
              </div>
              <div>
                <span className="font-medium text-gray-500">{result.skipped}</span>{' '}
                <span className="text-gray-600">skipped</span>
              </div>
              <div>
                <span className="font-medium text-red-700">{result.errored}</span>{' '}
                <span className="text-gray-600">errored</span>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-gray-200 divide-y divide-gray-100">
              {result.results.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  {r.status === 'migrated' ? (
                    <CheckCircle className="h-4 w-4 shrink-0 text-green-600" />
                  ) : r.status === 'error' ? (
                    <XCircle className="h-4 w-4 shrink-0 text-red-600" />
                  ) : (
                    <div className="h-4 w-4 shrink-0 rounded-full border border-gray-300" />
                  )}
                  <span className="flex-1 truncate text-gray-800">{r.name}</span>
                  {r.node_count !== undefined && r.node_count > 0 && (
                    <span className="shrink-0 text-xs text-gray-500">{r.node_count} node{r.node_count === 1 ? '' : 's'}</span>
                  )}
                  {r.error && (
                    <span className="shrink-0 max-w-sm truncate text-xs text-red-600" title={r.error}>
                      {r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </NavLayout>
  )
}
