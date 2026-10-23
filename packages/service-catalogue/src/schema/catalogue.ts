import { ANTHROPIC_SERVICE } from './services/anthropic'
import { GOOGLE_SERVICE } from './services/google'
import { OPENAI_SERVICE } from './services/openai'
import { SALESFORCE_SERVICE } from './services/salesforce'
import { SLACK_SERVICE } from './services/slack'
import { SNOWFLAKE_SERVICE } from './services/snowflake'
import type { ServiceSchema } from './types'

/**
 * The shipped catalogue: every service, its actions and its connection,
 * declaratively. Each service arrives in its own PR of #2337 with its runtime
 * half, its run files and their fingerprints, and catalogue.test.ts holds them
 * all to the same checks. Snowflake was the first, then Slack, OpenAI and Anthropic;
 * Salesforce's entry came ahead of its actions, with its connection only (#2338),
 * and its actions followed; then Google, one service for Sheets, Gmail, Drive
 * and Calendar, as the settled design draws one Google tile.
 *
 * In the order the Add connection tiles are drawn, by name, as the settled
 * design lists them (schema/connection.test.ts holds that).
 */
export const CATALOGUE: readonly ServiceSchema[] = [ANTHROPIC_SERVICE, GOOGLE_SERVICE, OPENAI_SERVICE, SALESFORCE_SERVICE, SLACK_SERVICE, SNOWFLAKE_SERVICE]
