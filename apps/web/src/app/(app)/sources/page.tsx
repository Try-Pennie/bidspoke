'use client'

export const runtime = 'edge'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import NavLayout from '@/components/NavLayout'
import { Copy, Plus, Key, KeyRound, Check, Eye, EyeOff, Terminal, Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://your-worker.workers.dev'

interface Source {
  name: string
  api_key: string
  created_at: string
}

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const [copyCurlCount, setCopyCurlCount] = useState(0)
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null)
  const [removingName, setRemovingName] = useState<string | null>(null)
  const removeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null)
  const revokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const keySpanRef = useRef<HTMLSpanElement | null>(null)
  const [displayedKey, setDisplayedKey] = useState('your_api_key')
  const prevExampleKeyRef = useRef('your_api_key')

  useEffect(() => {
    if (adding) {
      const frame = requestAnimationFrame(() => nameInputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
  }, [adding])

  async function load() {
    try {
      const data = await api.sources.list() as unknown as Source[]
      setSources(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sources')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Default selected source to first in list when sources load
  useEffect(() => {
    if (sources.length > 0 && !selectedSourceName) {
      setSelectedSourceName(sources[0].name)
    }
  }, [sources, selectedSourceName])

  const selectedSource = sources.find((s) => s.name === selectedSourceName) ?? sources[0] ?? null
  const exampleKey = selectedSource
    ? `${selectedSource.api_key.slice(0, 8)}${'•'.repeat(16)}`
    : 'your_api_key'

  // Animate the key line in the cURL panel when selection changes
  useEffect(() => {
    const prev = prevExampleKeyRef.current
    prevExampleKeyRef.current = exampleKey
    if (exampleKey === prev) return
    // Skip animation on initial data load
    if (prev === 'your_api_key' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplayedKey(exampleKey)
      return
    }
    const el = keySpanRef.current
    if (!el) { setDisplayedKey(exampleKey); return }
    const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'forwards' })
    out.onfinish = () => {
      setDisplayedKey(exampleKey)
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-in' })
    }
    return () => out.cancel()
  }, [exampleKey])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.sources.create(newName.trim())
      setNewName('')
      setAdding(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create source')
    } finally {
      setSaving(false)
    }
  }

  function requestRevoke(name: string) {
    if (revokeTimerRef.current) clearTimeout(revokeTimerRef.current)
    setConfirmingRevoke(name)
    revokeTimerRef.current = setTimeout(() => setConfirmingRevoke(null), 4000)
  }

  function cancelRevoke() {
    if (revokeTimerRef.current) clearTimeout(revokeTimerRef.current)
    setConfirmingRevoke(null)
  }

  async function handleDelete(name: string) {
    if (revokeTimerRef.current) clearTimeout(revokeTimerRef.current)
    setConfirmingRevoke(null)
    const item = sources.find((s) => s.name === name)
    setRemovingName(name)
    removeTimerRef.current = setTimeout(() => {
      setSources((prev) => {
        const next = prev.filter((s) => s.name !== name)
        if (selectedSourceName === name) setSelectedSourceName(next[0]?.name ?? null)
        return next
      })
      setRemovingName(null)
    }, 150)
    try {
      await api.sources.delete(name)
    } catch (e) {
      if (removeTimerRef.current) clearTimeout(removeTimerRef.current)
      setRemovingName(null)
      if (item) setSources((prev) => prev.find((s) => s.name === name) ? prev : [...prev, item])
      setError(e instanceof Error ? e.message : 'Failed to revoke source')
    }
  }

  async function handleCopy(key: string) {
    await navigator.clipboard.writeText(key)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const exampleSource = selectedSource?.name ?? 'your_source'

  const curlExample = `curl -X POST \\
  "${WORKER_URL}/webhooks/{workflow_id}" \\
  -H "X-API-Key: ${displayedKey}" \\
  -H "Content-Type: application/json" \\
  -H "X-Idempotency-Key: $(uuidgen)" \\
  -d '{"your": "payload"}'`

  async function handleCopyCurl() {
    const raw = `curl -X POST \\
  "${WORKER_URL}/webhooks/{workflow_id}" \\
  -H "X-API-Key: ${selectedSource?.api_key ?? 'your_api_key'}" \\
  -H "Content-Type: application/json" \\
  -H "X-Idempotency-Key: $(uuidgen)" \\
  -d '{"your": "payload"}'`
    await navigator.clipboard.writeText(raw)
    setCopiedCurl(true)
    setCopyCurlCount((n) => n + 1)
    setTimeout(() => setCopiedCurl(false), 2000)
  }

  return (
    <NavLayout>
      <div className="p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-graphite">API Sources</h1>
            <p className="mt-1 text-sm text-gray-500">
              Each source gets a unique API key passed in the <code className="rounded bg-gray-100 px-1 font-mono text-xs">X-API-Key</code> header.
              The source name is available as <code className="rounded bg-gray-100 px-1 font-mono text-xs">trigger.source</code> in workflows.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            disabled={adding}
            className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-0 disabled:pointer-events-none"
          >
            <Plus className="h-4 w-4" />
            New source
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${adding ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="mb-6 max-w-md rounded-xl border border-gray-200 bg-white p-5" inert={!adding || undefined}>
              <p className="mb-4 text-sm font-medium text-gray-400">New source</p>
              <form onSubmit={handleAdd} className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Source name</label>
                  <input
                    ref={nameInputRef}
                    className="input w-full font-mono"
                    placeholder="wallet_owl"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/\s/g, '_'))}
                    required
                  />
                  <p className="mt-1 text-xs text-gray-400">Lowercase letters, numbers, underscores. Used as <code className="rounded bg-gray-100 px-1 font-mono">trigger.source</code> in workflows.</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex items-center gap-2 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0] disabled:opacity-50"
                  >
                    {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating…</> : 'Generate key'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAdding(false); setNewName('') }}
                    className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-graphite"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">

          {/* Left — sources list */}
          <div>
            {loading ? (
              <div className="space-y-3">
                {[...Array(2)].map((_, i) => (
                  <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-7 w-16 rounded-lg" />
                    </div>
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                      <Skeleton className="h-9 w-10 rounded-lg" />
                      <Skeleton className="h-9 w-20 rounded-lg" />
                    </div>
                  </div>
                ))}
              </div>
            ) : sources.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
                <Key className="mx-auto mb-3 h-6 w-6 text-gray-300" />
                <p className="text-base font-semibold text-graphite">No API sources yet</p>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-400">
                  Each source gets a unique API key. Pass it in the <code className="rounded bg-gray-100 px-1 text-xs">X-API-Key</code> header when triggering a workflow. It shows up as <code className="rounded bg-gray-100 px-1 text-xs">trigger.source</code> in your steps.
                </p>
                <button
                  onClick={() => setAdding(true)}
                  className="mt-4 rounded-lg bg-p-blue-dark px-4 py-2 text-sm font-medium text-white hover:bg-[#3A8FD0]"
                >
                  Add your first source
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {sources.map((source) => (
                  <div
                    key={source.name}
                    className={`cursor-pointer rounded-xl border bg-white p-4 transition-[colors,opacity] duration-150 ${
                      selectedSourceName === source.name
                        ? 'border-p-blue-light ring-2 ring-p-blue-dark/20'
                        : 'border-gray-200 hover:border-gray-300'
                    } ${removingName === source.name ? 'opacity-0' : ''}`}
                    onClick={() => setSelectedSourceName(source.name)}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <p className="font-mono text-sm font-semibold text-graphite">{source.name}</p>
                      {confirmingRevoke === source.name ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(source.name) }}
                            className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600"
                          >
                            Revoke
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); cancelRevoke() }} className="text-xs text-gray-400 hover:text-gray-600">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); requestRevoke(source.name) }}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          Revoke
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700">
                        {revealedKeys.has(source.api_key)
                          ? source.api_key
                          : `${source.api_key.slice(0, 8)}${'•'.repeat(24)}`}
                      </code>
                      <button
                        onClick={(e) => { e.stopPropagation(); setRevealedKeys((prev) => { const next = new Set(prev); next.has(source.api_key) ? next.delete(source.api_key) : next.add(source.api_key); return next }) }}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-beige"
                        title={revealedKeys.has(source.api_key) ? 'Hide' : 'Reveal'}
                      >
                        {revealedKeys.has(source.api_key) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCopy(source.api_key) }}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-beige"
                      >
                        {copiedKey === source.api_key ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        {copiedKey === source.api_key ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right — usage reference */}
          <div className="h-fit lg:sticky lg:top-8">
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-700">How to trigger a workflow</span>
                </div>
                {sources.length > 1 ? (
                  <select
                    value={selectedSourceName ?? ''}
                    onChange={(e) => setSelectedSourceName(e.target.value)}
                    className="rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs text-gray-600 focus:outline-none"
                  >
                    {sources.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                ) : sources.length === 1 ? (
                  <span className="font-mono text-xs text-gray-500">{sources[0].name}</span>
                ) : null}
              </div>

              {/* Code block */}
              <div className="relative bg-gray-950 px-4 py-4">
                <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-gray-300 whitespace-pre-wrap break-words">
                  <span className="text-gray-500">{'# source: '}</span>
                  <span className="text-amber-400">{exampleSource}</span>
                  {'\n'}
                  {curlExample.split('\n').map((line, i) => {
                    // colorize pieces
                    if (line.includes('X-API-Key')) {
                      const [label, val] = line.split(': ')
                      return <span key={i}>{label + ': '}<span ref={keySpanRef} className="text-green-400">{val}</span>{'\n'}</span>
                    }
                    if (line.includes('workflow_id')) {
                      return <span key={i}>{line.replace('{workflow_id}', '')}<span className="text-sky-400">{'{'+'workflow_id}'}</span>{'\n'}</span>
                    }
                    return <span key={i} className={line.startsWith('  -d') ? 'text-gray-400' : ''}>{line}{'\n'}</span>
                  })}
                </pre>
                <button
                  onClick={handleCopyCurl}
                  className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                >
                  {copiedCurl ? <Check key={copyCurlCount} className="h-3 w-3 text-green-400 copy-confirm" /> : <Copy className="h-3 w-3" />}
                  {copiedCurl ? 'Copied' : 'Copy'}
                </button>
              </div>

              {/* Notes */}
              <div className="space-y-2.5 px-4 py-3 text-xs text-gray-500">
                <p>
                  Find <code className="rounded bg-gray-100 px-1 font-mono">workflow_id</code> in the URL when you open a workflow:{' '}
                  <span className="font-mono text-gray-400">/workflows/&#123;id&#125;</span>
                </p>
                <p>
                  <code className="rounded bg-gray-100 px-1 font-mono">X-Idempotency-Key</code> is optional but recommended. Generate a unique ID (any UUID) for each trigger attempt. If your caller retries with the same key within 5 minutes, the workflow won&apos;t run twice. <code className="rounded bg-gray-100 px-1 font-mono">$(uuidgen)</code> generates one on Mac/Linux.
                </p>
                <p>
                  The source name <code className="rounded bg-gray-100 px-1 font-mono">{exampleSource}</code> is available as{' '}
                  <code className="rounded bg-gray-100 px-1 font-mono">trigger.source</code> in every workflow step.
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </NavLayout>
  )
}
