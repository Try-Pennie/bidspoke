/**
 * The shape of workflow-values-live.json and the summary both its writer
 * (scripts/measure-workflow-values-fixture.ts) and its test compare by.
 */
import type { PartnerValueReaders, ScannableWorkflow, ScanPartner } from '../../partner-workflow-values'

/** One value's answer, reduced to what identifies it: who reads it, where, and how. */
export interface ValueSummary {
  key: string
  readers: Array<{ workflow_id: string; reads: string; places: string[] }>
  shadowed_by: string[]
}

export interface LiveFixture {
  about: string
  mirror_commit: string
  partners: ScanPartner[]
  workflows: ScannableWorkflow[]
  expected: Record<string, ValueSummary[]>
}

export function summarize(scan: readonly PartnerValueReaders[]): ValueSummary[] {
  return scan.map((v) => ({
    key: v.key,
    readers: v.readers.map((r) => ({
      workflow_id: r.workflow_id,
      reads: r.reads,
      places: r.places.map((p) => `${p.edge_id !== null ? `edge ${p.edge_id}` : `node ${p.namespace}`} ${p.reads}`),
    })),
    shadowed_by: v.shadowed_data_keys.map((s) => `${s.workflow_id} ${s.namespace}`),
  }))
}
