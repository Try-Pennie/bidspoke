import { ANTHROPIC_CHAT_V1 } from '../schema/services/anthropic'
import {
  OPENAI_ADD_CONVERSATION_ITEMS_V1, OPENAI_CHAT_V1, OPENAI_CREATE_CONVERSATION_V1, OPENAI_CREATE_RESPONSE_V1, OPENAI_GET_CONVERSATION_V1,
  OPENAI_LIST_CONVERSATION_ITEMS_V1,
} from '../schema/services/openai'
import { SLACK_SEND_MESSAGE_V1 } from '../schema/services/slack'
import { SNOWFLAKE_EXECUTE_SQL_QUERY_V1, SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1 } from '../schema/services/snowflake'
import { run as anthropicChatV1 } from './actions/anthropic.chat.v1'
import { run as openaiAddConversationItemsV1 } from './actions/openai.add-conversation-items.v1'
import { run as openaiChatV1 } from './actions/openai.chat.v1'
import { run as openaiCreateConversationV1 } from './actions/openai.create-conversation.v1'
import { run as openaiCreateResponseV1 } from './actions/openai.create-response.v1'
import { run as openaiGetConversationV1 } from './actions/openai.get-conversation.v1'
import { run as openaiListConversationItemsV1 } from './actions/openai.list-conversation-items.v1'
import { run as slackSendMessageV1 } from './actions/slack.send-message.v1'
import { run as snowflakeExecuteSqlQueryV1 } from './actions/snowflake.execute-sql-query.v1'
import { run as snowflakeInsertMultipleRowsV1 } from './actions/snowflake.insert-multiple-rows.v1'
import { implement, type RuntimeAction, type ServiceRuntime } from './types'

/**
 * Every shipped action's run, paired with its schema through `implement`, and
 * every service's auth functions. Each service arrives in its own PR of #2337.
 *
 * Each action's run is exported as `run` from its own file,
 * `runtime/actions/<key>.v<version>.ts`, and imported here. The catalogue
 * checks import that file and refuse a registered run that is not the one it
 * exports, because the version fingerprint is taken over that file and what it
 * imports: a run written anywhere else would change without its fingerprint
 * moving.
 */
export const RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  implement(SNOWFLAKE_EXECUTE_SQL_QUERY_V1, snowflakeExecuteSqlQueryV1),
  implement(SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1, snowflakeInsertMultipleRowsV1),
  implement(SLACK_SEND_MESSAGE_V1, slackSendMessageV1),
  implement(OPENAI_CHAT_V1, openaiChatV1),
  implement(OPENAI_CREATE_RESPONSE_V1, openaiCreateResponseV1),
  implement(OPENAI_CREATE_CONVERSATION_V1, openaiCreateConversationV1),
  implement(OPENAI_ADD_CONVERSATION_ITEMS_V1, openaiAddConversationItemsV1),
  implement(OPENAI_LIST_CONVERSATION_ITEMS_V1, openaiListConversationItemsV1),
  implement(OPENAI_GET_CONVERSATION_V1, openaiGetConversationV1),
  implement(ANTHROPIC_CHAT_V1, anthropicChatV1),
]

/**
 * Anthropic has no entry: a static API key needs no consent URL or refresh,
 * and its verify is the ops Worker's free models call (apps/worker
 * src/ops/connections/anthropic-service.ts).
 *
 * OpenAI has no entry: a static API key needs no consent URL or refresh, and
 * its verify is the ops Worker's free models call (apps/worker
 * src/ops/connections/openai-service.ts).
 *
 * Slack has no entry either: a static bot token needs no consent URL or
 * refresh, and its verify is the ops Worker's auth.test probe
 * (apps/worker src/ops/connections/slack-service.ts).
 *
 * Snowflake has no entry: a key pair login needs no consent URL or refresh, and
 * its verify is the ops Worker's identity probe (apps/worker
 * src/ops/connections/snowflake-service.ts), which sends its statement through
 * this package's Snowflake client (runtime/snowflake/statement.ts).
 */
export const SERVICE_RUNTIMES: readonly ServiceRuntime[] = []
