/**
 * The step a parallel block writes its cut-off row under (#3071).
 *
 * When a block stops waiting for a slot still running, it writes that slot's
 * row itself, marked as the block's deadline (#3047), with the request the slot
 * noted last (#3064). The slot's own late finish writes nothing (#63), so this
 * row is the only record of the step it was on.
 *
 * It used to go under the slot's FIRST step. A slot that had finished that step
 * and was cut off on a later one gave its first step a second row (completed,
 * then failed by the block) and left the step it was running with none. So the
 * block follows each slot's steps here: the one it started last, whether that
 * step has written its own row yet, and the request each step noted.
 *
 * The run's step outputs (`ctx.steps`) record the cut-off under the same step
 * (#3082), so a step the slot finished keeps the output a later step reads.
 *
 * A slot whose running step already wrote its row is given no cut-off row: that
 * can only happen when the step finished in the instant between the block
 * deciding and the block giving up, and a second row is exactly what #63 rules
 * out.
 */
import type { NodeDefinition, ResolvedStepInput } from '../types'

/** A step of a slot, as its row would place it. */
export interface SlotStep {
  node: NodeDefinition
  stepOrder: number
  startedAt: string
}

/** The step a cut-off row is written under, and the request it carries. */
export interface CutOffStep extends SlotStep {
  input: ResolvedStepInput | null
}

export class SlotSteps {
  private readonly running = new Map<number, SlotStep & { recorded: boolean }>()
  private readonly notes = new Map<number, { namespace: string; input: ResolvedStepInput }>()

  /** A step of the slot started. */
  start(slot: number, step: SlotStep): void {
    this.running.set(slot, { ...step, recorded: false })
  }

  /** A step of the slot wrote its own row. */
  record(slot: number, namespace: string): void {
    const step = this.running.get(slot)
    if (step && step.node.namespace === namespace) step.recorded = true
  }

  /** A step of the slot noted the request it resolved (#3064): the masked object its own row would store. */
  note(slot: number, namespace: string, input: ResolvedStepInput): void {
    this.notes.set(slot, { namespace, input })
  }

  /**
   * The row to write for a slot the block stopped waiting for: the step it was
   * running, with that step's request when it noted one, or null when that step
   * already wrote its own row. A slot that reported no step is placed as its
   * first step at the block's start (`first`).
   */
  cutOff(slot: number, first: SlotStep): CutOffStep | null {
    const step = this.running.get(slot) ?? { ...first, recorded: false }
    if (step.recorded) return null
    const noted = this.notes.get(slot)
    // Only the request the running step noted: one an earlier step noted is not this step's.
    const input = noted && noted.namespace === step.node.namespace ? noted.input : null
    return { node: step.node, stepOrder: step.stepOrder, startedAt: step.startedAt, input }
  }
}
