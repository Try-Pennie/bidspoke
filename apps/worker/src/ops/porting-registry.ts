/**
 * Which Pipedream workflows the porting recorder accepts captures for, and
 * which capture step versions are current (#1705).
 *
 * Typed and in code, on purpose, for now: enrolling a workflow is a reviewed
 * pull request, which is the approval step decision D2 asks for ("installed per
 * workflow when its port starts and removed at cutover"), and the receiver
 * needs no database to answer. A workflow is added here when its recorder is
 * installed and removed at its cutover. When the ops database lands (0.E) this
 * moves to the inventory row, and this file is deleted with that change.
 *
 * Empty until Dan approves the first workflow, so until then every capture is
 * refused as `unknown_workflow`.
 */
import { CAPTURE_VERSION } from '@bidspoke/porting-evidence'

export interface EnrolledWorkflow {
  /** The workflow's name in Pipedream, for whoever reads a refusal. */
  name: string
  /** ISO date the recorder was installed. */
  enrolledOn: string
}

export interface PortingRegistry {
  /** Keyed by Pipedream hashid (`p_...`). */
  enrolled: Readonly<Record<string, EnrolledWorkflow>>
  /** Capture versions stored normally; any other is stored quarantined. */
  currentCaptureVersions: readonly number[]
}

export const PORTING_REGISTRY: PortingRegistry = {
  enrolled: {},
  currentCaptureVersions: [CAPTURE_VERSION],
}
