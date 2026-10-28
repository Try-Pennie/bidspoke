/**
 * The GitHub backup of a written workflow version (#2868).
 *
 * Every version snapshot written (a canvas save, a version restore, a
 * Connections Replace, and since #2879 a create's first version and the
 * version a duplicate's definition is) is pushed to the backup repo as the workflow's file, and
 * the commit is stamped on the version row. This is called from one place
 * only, writeWorkflow (lib/write-workflow.ts), for every op that writes a
 * version, so no route can write a version and leave the backup holding the
 * one before it. Until #2868 the save route pushed and nothing else did, so
 * after a restore the backup held the replaced definition until someone next
 * saved the workflow on the canvas.
 *
 * The push runs after the write has been answered, through the caller's
 * waitUntil, and never fails the write. A failed push is recorded for the
 * backup failure alert (lib/github-backup-alert.ts), except from a local dev
 * process, which shares production's Slack. #2640 is the retry of a failed push.
 * apps/web/src/lib/__guards__/worker/workflow-backup-every-writer.test.ts holds
 * these calls to that shape.
 */
import type { createSupabaseClient } from './supabase'
import type { Env } from '../env'
import { pushWorkflowToGitHub } from './github'
import { recordBackupFailure, recordBackupSuccess } from './github-backup-alert'
import { isNoRowMatchedError, requireRowsAffected } from './db-retry'

type Supabase = ReturnType<typeof createSupabaseClient>

/** What a definition writer hands writeWorkflow so the version it writes is backed up. */
export interface WorkflowBackupContext {
  env: Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_REPO' | 'IDEMPOTENCY' | 'APP_URL' | 'LOCAL_DEV'>
  /** The request's waitUntil, so the push outlives the response without delaying it. */
  waitUntil: (promise: Promise<unknown>) => void
}

export interface WrittenVersion {
  orgId: string
  workflowId: string
  workflowName: string
  /** The definition as stored by the write. */
  definition: unknown
  /** The version row written, or null when the write's answer named none (reported, never stamped). */
  versionId: string | null
  versionNumber: number | null
  /** The commit message, or undefined for the default one naming the workflow and version. */
  message: string | undefined
}

/** Pushes one written version to the backup repo in the background, and stamps its commit on the version row. */
export function backUpWrittenVersion(supabase: Supabase, backup: WorkflowBackupContext, written: WrittenVersion): void {
  const { env } = backup
  const { orgId, workflowId, workflowName, versionId } = written
  backup.waitUntil(
    // Started inside a then, so a push that throws before returning a promise
    // is a failed backup like any other, never a throw into the write's caller.
    Promise.resolve()
      .then(() => pushWorkflowToGitHub(env.GITHUB_TOKEN, env.GITHUB_REPO, workflowId, workflowName, written.definition, written.versionNumber, written.message))
      .then(async (commitSha) => {
        // null = backup not configured (no token/repo): not a failure, leave the streak alone.
        if (!commitSha) return
        // Runs after the write has already been answered, so there is no response
        // to fail. Both a real error and a zero-row match were discarded here,
        // leaving a version row with no commit_sha that still looked like a
        // healthy backup. The GitHub push itself did succeed, so the streak is
        // still reset; only the bookkeeping is reported as broken (#588).
        // write_workflow names the snapshot it wrote; an answer without one leaves
        // nothing to stamp, reported as the unset stamp it is, never sent as an empty id.
        const { error: stampError } = versionId
          ? await requireRowsAffected(
            'workflow_versions.commit_sha',
            () => supabase.from('workflow_versions').update({ commit_sha: commitSha }).eq('id', versionId).select('id'),
            { onMiss: 'error', context: { workflow_id: workflowId, version_id: versionId } }
          )
          : { error: new Error('write_workflow answered the write without the id of the version it wrote') }
        if (stampError && !isNoRowMatchedError(stampError)) {
          console.error(
            JSON.stringify({
              event: 'workflow_version_commit_sha_unset',
              workflow_id: workflowId,
              version_id: versionId,
              reason: stampError.message,
            })
          )
        }
        await recordBackupSuccess(env.IDEMPOTENCY, orgId)
      })
      .catch(async (e) => {
        console.error('[github] backup failed:', e)
        // LOCAL_DEV (set only in .dev.vars, never in production) means this write is
        // running against the real production Supabase/Slack connection from a local
        // `wrangler dev` process, which has no GITHUB_TOKEN. Recording the failure here
        // would trip the real org's backup-failure Slack alert from local testing.
        if (env.LOCAL_DEV) return
        await recordBackupFailure({
          supabase,
          kv: env.IDEMPOTENCY,
          orgId,
          workflowId,
          workflowName,
          error: e,
          appUrl: env.APP_URL,
        }).catch((alertErr) => console.error('[github] backup alert failed:', alertErr))
      })
  )
}
