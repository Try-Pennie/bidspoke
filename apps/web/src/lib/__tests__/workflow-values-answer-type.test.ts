/**
 * The page's type for the workflow values answer (#2142) is the Worker's, field
 * for field: the web cannot import the Worker's route at run time, so it keeps
 * its own copy in lib/api.ts, and this holds the two equal in both directions.
 * A field added, removed or retyped on either side fails the typecheck.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { WorkflowValuesAnswer } from '../../../../worker/src/lib/workflow-values-shape'
import type { PartnerWorkflowValues } from '../api'

describe('the workflow values answer type', () => {
  it('is the same on the page as in the Worker', () => {
    expectTypeOf<PartnerWorkflowValues>().toEqualTypeOf<WorkflowValuesAnswer>()
  })
})
