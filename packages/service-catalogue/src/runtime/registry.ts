import { ANTHROPIC_CHAT_V1 } from '../schema/services/anthropic'
import {
  GOOGLE_CALENDAR_CREATE_EVENT_V1, GOOGLE_CALENDAR_DELETE_EVENT_V1, GOOGLE_CALENDAR_LIST_EVENTS_V1, GOOGLE_DRIVE_DOWNLOAD_FILE_V1, GOOGLE_DRIVE_DOWNLOAD_FILE_V2, GOOGLE_DRIVE_LIST_FILES_V1, GOOGLE_DRIVE_LIST_FILES_V2, GOOGLE_GMAIL_SEND_EMAIL_V1, GOOGLE_SHEETS_ADD_ROW_V1, GOOGLE_SHEETS_ADD_ROWS_V1, GOOGLE_SHEETS_CLEAR_ROWS_V1, GOOGLE_SHEETS_CREATE_WORKSHEET_V1, GOOGLE_SHEETS_DELETE_ROWS_V1, GOOGLE_SHEETS_FIND_ROW_V1, GOOGLE_SHEETS_GET_CELL_V1, GOOGLE_SHEETS_GET_SPREADSHEET_V1, GOOGLE_SHEETS_GET_VALUES_V1, GOOGLE_SHEETS_UPDATE_CELL_V1,
} from '../schema/services/google'
import { HTTP_CUSTOM_REQUEST_V1, HTTP_GET_REQUEST_V1 } from '../schema/services/http'
import {
  OPENAI_ADD_CONVERSATION_ITEMS_V1, OPENAI_CHAT_V1, OPENAI_CREATE_CONVERSATION_V1, OPENAI_CREATE_RESPONSE_V1, OPENAI_GET_CONVERSATION_V1,
  OPENAI_LIST_CONVERSATION_ITEMS_V1,
} from '../schema/services/openai'
import {
  SALESFORCE_APEX_REST_V1, SALESFORCE_BULK_INGEST_V1, SALESFORCE_CREATE_RECORD_V1, SALESFORCE_CREATE_RECORDS_V1, SALESFORCE_GET_INGEST_JOB_V1, SALESFORCE_QUERY_V1,
  SALESFORCE_SOQL_SEARCH_V1, SALESFORCE_UPDATE_RECORD_V1, SALESFORCE_UPDATE_RECORDS_V1, SALESFORCE_UPSERT_RECORD_V1,
} from '../schema/services/salesforce'
import { SLACK_SEND_MESSAGE_V1 } from '../schema/services/slack'
import { SNOWFLAKE_EXECUTE_SQL_QUERY_V1, SNOWFLAKE_INSERT_MULTIPLE_ROWS_V1 } from '../schema/services/snowflake'
import { SUPABASE_INSERT_ROW_V1, SUPABASE_SELECT_ROW_V1, SUPABASE_UPDATE_ROW_V1 } from '../schema/services/supabase'
import { run as anthropicChatV1 } from './actions/anthropic.chat.v1'
import { run as googleCalendarCreateEventV1 } from './actions/google.calendar-create-event.v1'
import { run as googleCalendarDeleteEventV1 } from './actions/google.calendar-delete-event.v1'
import { run as googleCalendarListEventsV1 } from './actions/google.calendar-list-events.v1'
import { run as googleDriveDownloadFileV1 } from './actions/google.drive-download-file.v1'
import { run as googleDriveDownloadFileV2 } from './actions/google.drive-download-file.v2'
import { run as googleDriveListFilesV1 } from './actions/google.drive-list-files.v1'
import { run as googleDriveListFilesV2 } from './actions/google.drive-list-files.v2'
import { run as googleGmailSendEmailV1 } from './actions/google.gmail-send-email.v1'
import { run as googleSheetsAddRowV1 } from './actions/google.sheets-add-row.v1'
import { run as googleSheetsAddRowsV1 } from './actions/google.sheets-add-rows.v1'
import { run as googleSheetsClearRowsV1 } from './actions/google.sheets-clear-rows.v1'
import { run as googleSheetsCreateWorksheetV1 } from './actions/google.sheets-create-worksheet.v1'
import { run as googleSheetsDeleteRowsV1 } from './actions/google.sheets-delete-rows.v1'
import { run as googleSheetsFindRowV1 } from './actions/google.sheets-find-row.v1'
import { run as googleSheetsGetCellV1 } from './actions/google.sheets-get-cell.v1'
import { run as googleSheetsGetSpreadsheetV1 } from './actions/google.sheets-get-spreadsheet.v1'
import { run as googleSheetsGetValuesV1 } from './actions/google.sheets-get-values.v1'
import { run as googleSheetsUpdateCellV1 } from './actions/google.sheets-update-cell.v1'
import { run as httpCustomRequestV1 } from './actions/http.custom-request.v1'
import { run as httpGetRequestV1 } from './actions/http.get-request.v1'
import { run as openaiAddConversationItemsV1 } from './actions/openai.add-conversation-items.v1'
import { run as openaiChatV1 } from './actions/openai.chat.v1'
import { run as openaiCreateConversationV1 } from './actions/openai.create-conversation.v1'
import { run as openaiCreateResponseV1 } from './actions/openai.create-response.v1'
import { run as openaiGetConversationV1 } from './actions/openai.get-conversation.v1'
import { run as openaiListConversationItemsV1 } from './actions/openai.list-conversation-items.v1'
import { run as salesforceApexRestV1 } from './actions/salesforce.apex-rest.v1'
import { run as salesforceBulkIngestV1 } from './actions/salesforce.bulk-ingest.v1'
import { run as salesforceCreateRecordV1 } from './actions/salesforce.create-record.v1'
import { run as salesforceCreateRecordsV1 } from './actions/salesforce.create-records.v1'
import { run as salesforceGetIngestJobV1 } from './actions/salesforce.get-ingest-job.v1'
import { run as salesforceQueryV1 } from './actions/salesforce.query.v1'
import { run as salesforceSoqlSearchV1 } from './actions/salesforce.soql-search.v1'
import { run as salesforceUpdateRecordV1 } from './actions/salesforce.update-record.v1'
import { run as salesforceUpdateRecordsV1 } from './actions/salesforce.update-records.v1'
import { run as salesforceUpsertRecordV1 } from './actions/salesforce.upsert-record.v1'
import { run as slackSendMessageV1 } from './actions/slack.send-message.v1'
import { run as snowflakeExecuteSqlQueryV1 } from './actions/snowflake.execute-sql-query.v1'
import { run as snowflakeInsertMultipleRowsV1 } from './actions/snowflake.insert-multiple-rows.v1'
import { run as supabaseInsertRowV1 } from './actions/supabase.insert-row.v1'
import { run as supabaseSelectRowV1 } from './actions/supabase.select-row.v1'
import { run as supabaseUpdateRowV1 } from './actions/supabase.update-row.v1'
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
  implement(SALESFORCE_SOQL_SEARCH_V1, salesforceSoqlSearchV1),
  implement(SALESFORCE_QUERY_V1, salesforceQueryV1),
  implement(SALESFORCE_CREATE_RECORD_V1, salesforceCreateRecordV1),
  implement(SALESFORCE_UPDATE_RECORD_V1, salesforceUpdateRecordV1),
  implement(SALESFORCE_UPSERT_RECORD_V1, salesforceUpsertRecordV1),
  implement(SALESFORCE_CREATE_RECORDS_V1, salesforceCreateRecordsV1),
  implement(SALESFORCE_UPDATE_RECORDS_V1, salesforceUpdateRecordsV1),
  implement(SALESFORCE_APEX_REST_V1, salesforceApexRestV1),
  implement(SALESFORCE_BULK_INGEST_V1, salesforceBulkIngestV1),
  implement(SALESFORCE_GET_INGEST_JOB_V1, salesforceGetIngestJobV1),
  implement(GOOGLE_SHEETS_ADD_ROW_V1, googleSheetsAddRowV1),
  implement(GOOGLE_SHEETS_ADD_ROWS_V1, googleSheetsAddRowsV1),
  implement(GOOGLE_SHEETS_UPDATE_CELL_V1, googleSheetsUpdateCellV1),
  implement(GOOGLE_SHEETS_GET_VALUES_V1, googleSheetsGetValuesV1),
  implement(GOOGLE_SHEETS_FIND_ROW_V1, googleSheetsFindRowV1),
  implement(GOOGLE_SHEETS_GET_CELL_V1, googleSheetsGetCellV1),
  implement(GOOGLE_SHEETS_GET_SPREADSHEET_V1, googleSheetsGetSpreadsheetV1),
  implement(GOOGLE_SHEETS_CREATE_WORKSHEET_V1, googleSheetsCreateWorksheetV1),
  implement(GOOGLE_SHEETS_DELETE_ROWS_V1, googleSheetsDeleteRowsV1),
  implement(GOOGLE_SHEETS_CLEAR_ROWS_V1, googleSheetsClearRowsV1),
  implement(GOOGLE_GMAIL_SEND_EMAIL_V1, googleGmailSendEmailV1),
  implement(GOOGLE_DRIVE_LIST_FILES_V1, googleDriveListFilesV1),
  implement(GOOGLE_DRIVE_DOWNLOAD_FILE_V1, googleDriveDownloadFileV1),
  implement(GOOGLE_DRIVE_LIST_FILES_V2, googleDriveListFilesV2),
  implement(GOOGLE_DRIVE_DOWNLOAD_FILE_V2, googleDriveDownloadFileV2),
  implement(GOOGLE_CALENDAR_CREATE_EVENT_V1, googleCalendarCreateEventV1),
  implement(GOOGLE_CALENDAR_DELETE_EVENT_V1, googleCalendarDeleteEventV1),
  implement(GOOGLE_CALENDAR_LIST_EVENTS_V1, googleCalendarListEventsV1),
  implement(HTTP_GET_REQUEST_V1, httpGetRequestV1),
  implement(HTTP_CUSTOM_REQUEST_V1, httpCustomRequestV1),
  implement(SUPABASE_INSERT_ROW_V1, supabaseInsertRowV1),
  implement(SUPABASE_SELECT_ROW_V1, supabaseSelectRowV1),
  implement(SUPABASE_UPDATE_ROW_V1, supabaseUpdateRowV1),
]

/**
 * Supabase has no entry: a static service key needs no consent URL or
 * refresh, and its verify is the ops Worker's GET of the project's REST root
 * (apps/worker src/ops/connections/supabase-service.ts).
 *
 * HTTP has no entry: a static key needs no consent URL or refresh, and its
 * verify is the ops Worker's GET of the connection's check path (apps/worker
 * src/ops/connections/http-service.ts).
 *
 * Google has no entry: a delegated token needs no consent URL, it is minted
 * again rather than refreshed, and its verify is the ops Worker's Gmail profile
 * probe (apps/worker src/ops/connections/google-service.ts).
 *
 * Salesforce has no entry: a client credentials login needs no consent URL,
 * its token is minted again rather than refreshed, and its verify is the ops
 * Worker's userinfo probe (apps/worker src/ops/connections/salesforce-service.ts).
 *
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
