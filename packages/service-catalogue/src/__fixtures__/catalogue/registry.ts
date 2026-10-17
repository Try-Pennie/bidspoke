import { implement, type RuntimeAction } from '../../runtime/types'
import { FIXTURE_ECHO_V1, FIXTURE_ECHO_V2 } from './schema'
import { run as echoV1 } from './actions/fixture.echo.v1'
import { run as echoV2 } from './actions/fixture.echo.v2'

/** TEST ONLY. The fixture's runtime half, paired the way the shipped registry pairs its actions. */
export const FIXTURE_RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  implement(FIXTURE_ECHO_V1, echoV1),
  implement(FIXTURE_ECHO_V2, echoV2),
]
