/**
 * A hand written workflow in the Pipedream export schema (workflow.json/2026.01).
 *
 * Its SHAPE copies what the 2026-09-30 export holds: an if/else control flow
 * step whose branches route to `deployments` pipelines, an end-workflow step in
 * some branches and not others, an http return step, and code steps that call
 * `$.flow.exit` and `$.respond` in the positions the export uses. Every value
 * and every line of code is invented here: nothing is copied from the export,
 * which must never be committed.
 */

export const controlFlowStep = (namespace: string, elseDeployment: string, ifDeployment?: string) => ({
  namespace,
  type: 'CodeCell',
  lang: 'nodejs20.x',
  component: true,
  uses: { registry: false, code: 'export default {\n  type: "action",\n  props: { _controlFlow: "any" },\n  run({ $ }) {\n    return $.flow\n  },\n}\n' },
  props: {
    _controlFlow: {
      type: 'ifelse',
      ifelse: {
        ifElses: [{ id: 'aaaa', n: 'ok', rules: { t: 'and', r: [] }, route: ifDeployment ? { pipeline: { id: 'p_IF', deploymentId: ifDeployment } } : {} }],
        _else: { shown: true, n: 'no', route: { pipeline: { id: 'p_ELSE', deploymentId: elseDeployment } } },
      },
    },
  },
})

export const codeStep = (namespace: string, code: string, extra: Record<string, unknown> = {}) => ({
  namespace,
  type: 'CodeCell',
  lang: 'nodejs20.x',
  component: true,
  uses: { registry: false, code },
  ...extra,
})

export const registryStep = (namespace: string, key: string, extra: Record<string, unknown> = {}) => ({
  namespace,
  type: 'CodeCell',
  lang: 'nodejs20.x',
  component: true,
  uses: { key, version: '0.0.4', registry: true },
  component_key: key,
  ...extra,
})

export const EXIT_AND_RESPOND = `import { axios } from "@pipedream/platform"

async function fail($, reason) {
  return $.flow.exit(reason)
}

export default defineComponent({
  async run({ steps, $ }) {
    const body = steps.trigger.event.body || {}
    if (!body.email) {
      await $.respond({ status: 400, body: { error: "missing email" } })
      return $.flow.exit("no email")
    }
    if (body.test) $.flow.exit("test lead")
    const seen = []
    for (const item of body.items || []) {
      if (item.bad) {
        $.flow.exit("bad item")
      }
      seen.push(item.id)
    }
    const check = () => $.flow.exit("sync exit")
    body.stop && $.flow.exit("expression exit")
    if (body.helper) await fail($, "helper exit")
    if (body.never) check()
    return { seen, status: "ok" }
  },
})
`

export const PLAIN_CODE = `export default defineComponent({
  async run({ steps, $ }) {
    return { doubled: (steps.trigger.event.body.n || 0) * 2 }
  },
})
`

export const fixtureWorkflow = () => ({
  schema: 'workflow.json/2026.01',
  id: 'p_FIXTURE',
  name: 'Fixture lead flow',
  settings: { error_notification: true },
  triggers: [{ type: 'http', props: { custom_response: true } }],
  steps: [
    controlFlowStep('check_method', 'd_reject'),
    codeStep('validate', EXIT_AND_RESPOND),
    controlFlowStep('route', 'd_slack', 'd_partner'),
    codeStep('compute', PLAIN_CODE),
    registryStep('return_response', 'http-return-http-response', { props: { resStatusCode: '<redacted>' } }),
    registryStep('disabled_end', 'end-end-workflow', { disabled: true }),
  ],
  deployments: {
    d_reject: {
      steps: [registryStep('return_reject', 'http-return-http-response'), registryStep('end_reject', 'end-end-workflow')],
    },
    d_partner: {
      steps: [registryStep('post_partner', 'http-custom-request'), controlFlowStep('nested', 'd_nested_end')],
    },
    d_nested_end: {
      steps: [registryStep('end_nested', 'end-end-workflow')],
    },
    d_slack: {
      steps: [registryStep('send_slack', 'http-custom-request')],
    },
  },
})
