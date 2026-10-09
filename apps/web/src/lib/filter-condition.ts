// Moved to @bidspoke/workflow-definition (#1698, Phase 1.1), so one implementation
// serves both apps. This re-export keeps the existing import path working for one
// release; callers move to the package and this file is deleted in a later change.
export { filterHasCondition, filterConditionSummary } from '@bidspoke/workflow-definition'
