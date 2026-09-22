/** A small status pill, one of four tones, shared by the bid attempt and buyer tables. */
export type Tone = 'green' | 'gray' | 'red' | 'amber'

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const cls = {
    green: 'bg-green-50 text-green-700',
    gray: 'bg-gray-100 text-gray-600',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
}
