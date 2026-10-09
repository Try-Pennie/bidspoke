// Moved to @bidspoke/workflow-definition (#1698, Phase 1.1), so one implementation
// serves both apps. This re-export keeps the existing import path working for one
// release; callers move to the package and this file is deleted in a later change.
//
// Only this module's own original API is re-exported (not the package's new
// structural node/edge types), so the path's public surface stays what it was.
export {
  validateWorkflow,
  findWorkflowCycle,
  findDuplicateOutEdges,
  buyerSelectRequiredHandles,
  findUnwiredRequiredHandles,
  validateWorkflowDef,
  type ValidationError,
} from '@bidspoke/workflow-definition'
