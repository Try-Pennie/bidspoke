// Moved to @bidspoke/workflow-definition (#1698, Phase 1.1), so one implementation
// serves both apps. This re-export keeps the existing import path working for one
// release; callers move to the package and this file is deleted in a later change.
//
// Only this module's own symbols are re-exported (not the whole package), so the
// path's public surface stays exactly what it was before the move.
export {
  duplicateLabelSet,
  duplicateBranchArmIndices,
  findBranchLabelConflicts,
  type BranchLabelConflict,
} from '@bidspoke/workflow-definition'
