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

/**
 * #1717: the run's `$` handed to a helper defined in the step, which responds or
 * exits through its own parameter name. Every helper shape the instrumenter
 * follows: a module level function, a const arrow, a const function
 * expression, a method of an object literal, a component method, a nested
 * helper that passes the parameter on, and a context or object carrying `$`.
 */
export const HELPER_RESPOND_AT_MODULE_LEVEL = `async function reply(d, body) {
  await d.respond({ status: 200, body })
}

export default defineComponent({
  async run({ steps, $ }) {
    await reply($, { ok: true })
    return { status: "ok" }
  },
})
`

export const HELPER_EXIT_AT_MODULE_LEVEL = `async function stop(d, why) {
  return d.flow.exit(why)
}

export default defineComponent({
  async run({ steps, $ }) {
    if (steps.trigger.event.body.test) await stop($, "test lead")
    return { status: "ok" }
  },
})
`

export const HELPERS_INSIDE_RUN = `export default defineComponent({
  async run({ steps, $ }) {
    const reply = async (d, body) => {
      await d.respond({ status: 200, body })
    }
    const stop = async function (d, why) {
      return d.flow.exit(why)
    }
    const replies = {
      async rejected(r) {
        await r.respond({ status: 400 })
      },
    }
    const outer = async (o) => {
      await inner(o)
    }
    async function inner(i) {
      await i.respond({ status: 202 })
    }
    const body = steps.trigger.event.body
    if (body.bad) await replies.rejected($)
    if (body.later) await outer($)
    if (body.test) await stop($, "test lead")
    await reply($, { ok: true })
    return { status: "ok" }
  },
})
`

export const HELPERS_OUTSIDE_RUN = `const replies = {
  ok: async (d) => {
    await d.respond({ status: 200 })
  },
}

async function replyWith({ $: d, body }) {
  await d.respond({ status: 201, body })
}

export default defineComponent({
  methods: {
    async reject(m) {
      await m.respond({ status: 400 })
    },
  },
  async run({ steps, $ }) {
    const body = steps.trigger.event.body
    if (body.bad) return await this.reject($)
    if (body.echo) return await replyWith({ $, body })
    await replies.ok($)
    return { status: "ok" }
  },
})
`

export const HELPER_THROUGH_RUN_CONTEXT = `export default defineComponent({
  async run(ctx) {
    const reply = async (c) => {
      await c.$.respond({ status: 200 })
    }
    await reply(ctx)
    return 1
  },
})
`

export const DOLLAR_KEPT_UNDER_ANOTHER_NAME = `export default defineComponent({
  async run({ $ }) {
    const d = $
    await d.respond({ status: 200 })
    return 1
  },
})
`

/** `$` passed only to things NOT defined in the step: must stay unrefused and untouched. */
export const DOLLAR_TO_AXIOS_ONLY = `import { axios } from "@pipedream/platform"

async function post(d, data) {
  return axios(d, { method: "POST", url: "https://partner.example.test/leads", data })
}

export default defineComponent({
  async run({ steps, $ }) {
    const ping = await axios($, { url: "https://partner.example.test/ping" })
    const posted = await post($, steps.trigger.event.body)
    $.export("posted", posted)
    return ping
  },
})
`

export const RESPOND_AND_EXIT_AS_VALUES = `export default defineComponent({
  async run({ $ }) {
    const send = $.respond.bind($)
    const { flow } = $
    await send({ status: 200 })
    return flow.exit("done")
  },
})
`

export const RESPOND_ON_AN_UNTRACED_RECEIVER = `import { withRetry } from "./retry.mjs"

export default defineComponent({
  async run({ $ }) {
    await withRetry(async (d) => {
      await d.respond({ status: 200 })
    }, $)
    return 1
  },
})
`

/** A respond inside `catch {` with no binding, a scope the scope library cannot scan by itself. */
export const HELPER_WITH_A_BARE_CATCH = `export default defineComponent({
  async run({ steps, $ }) {
    const reply = async (d) => {
      try {
        JSON.parse(steps.trigger.event.raw)
      } catch {
        await d.respond({ status: 400 })
        return
      }
      await d.respond({ status: 200 })
    }
    await reply($)
    return 1
  },
})
`

/** A helper whose own parameter hides the run's `ctx`, so `ctx.steps` there is not the run's. */
export const RUN_PARAMETER_SHADOWED = `export default defineComponent({
  async run(ctx) {
    const reply = async (ctx) => {
      await ctx.respond({ status: 200 })
    }
    const stop = async (ctx) => {
      return ctx.flow.exit("done")
    }
    await reply(ctx.$)
    return stop(ctx.$)
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
