import { describe, expect, it } from 'vitest'
import type { PipedreamWorkflow } from '../../instrument/instrument.ts'
import { workflowNeeds, type Capability } from '../needs.ts'
import { codeStep, registryStep, workflowFile } from './fixture.ts'

const wf = (extra: Record<string, unknown>) => workflowFile('p_x', extra) as unknown as PipedreamWorkflow
const caps = (w: PipedreamWorkflow): Capability[] => [...workflowNeeds(w).needs.keys()].sort()

describe('workflowNeeds (#1710)', () => {
  it('needs nothing new for an HTTP workflow of web requests, responses and plain code', () => {
    expect(caps(wf({ steps: [
      registryStep('call', 'http-custom-request'),
      codeStep('shape', 'export default defineComponent({ async run({ steps }) { return steps.call.$return_value } })'),
      registryStep('reply', 'http-return-http-response'),
      registryStep('stop', 'end-end-workflow'),
    ] }))).toEqual([])
  })

  it('counts axios and the platform helper as convertible to fetch, not as a library need', () => {
    expect(caps(wf({ steps: [codeStep('a', 'import axios from "axios"\nimport { axios as ax } from "@pipedream/platform"')] }))).toEqual([])
  })

  it('counts a convertible import written with a version as convertible too', () => {
    expect(caps(wf({ steps: [codeStep('a', 'import axios from "axios@1.6.0"\nimport { axios as ax } from "@pipedream/platform@3.0.3"')] }))).toEqual([])
    expect(caps(wf({ steps: [codeStep('a', 'import p from "papaparse@5.4.1"')] }))).toEqual(['code_runtime'])
  })

  it('needs the code runtime for any other library, a Node built in, or Buffer', () => {
    for (const code of ['import Papa from "papaparse"', 'const c = require("crypto")', 'import fs from "fs"', 'const b = Buffer.from(x, "base64")', 'const m = await import("luxon")']) {
      expect(caps(wf({ steps: [codeStep('a', code)] })), code).toEqual(['code_runtime'])
    }
  })

  it('needs the runner for SFTP and headless browsers, not the code runtime', () => {
    expect(caps(wf({ steps: [codeStep('a', 'import Client from "ssh2-sftp-client"')] }))).toEqual(['runner'])
    expect(caps(wf({ steps: [codeStep('a', 'import p from "puppeteer-core@21.11.0"')] }))).toEqual(['runner'])
  })

  it('needs connections for an app step or an app prop in code', () => {
    expect(caps(wf({ steps: [registryStep('a', 'google_sheets-add-single-row')] }))).toEqual(['connections'])
    expect(caps(wf({ steps: [codeStep('a', 'export default defineComponent({ props: { slack: { type: "app", app: "slack" } } })')] }))).toEqual(['connections'])
    expect(caps(wf({ steps: [codeStep('a', 'const t = this.salesforce.$auth.oauth_access_token')] }))).toEqual(['connections'])
  })

  it('needs data stores for a data store step, prop or service call', () => {
    expect(caps(wf({ steps: [registryStep('a', 'data_stores-add-update-record')] }))).toEqual(['data_stores'])
    expect(caps(wf({ steps: [codeStep('a', 'props: { db: { type: "data_store" } }')] }))).toEqual(['data_stores'])
    expect(caps(wf({ steps: [codeStep('a', 'await $.service.db.get("k")')] }))).toEqual(['data_stores'])
  })

  it('needs schedules for a timer trigger and non HTTP triggers for any other kind', () => {
    expect(caps(wf({ triggers: [{ type: 'timer' }] }))).toEqual(['schedules'])
    expect(caps(wf({ triggers: [{ type: 'email' }] }))).toEqual(['non_http_triggers'])
    expect(caps(wf({ triggers: [{ type: 'source' }] }))).toEqual(['non_http_triggers'])
    expect(caps(wf({ triggers: [{ type: 'source', disabled: true }, { type: 'http' }] }))).toEqual([])
  })

  it('needs long runs for a delay, a rerun, whole run retry, run limits, or a call to another Pipedream workflow', () => {
    expect(caps(wf({ steps: [registryStep('a', 'delay-workflow-delay')] }))).toEqual(['long_runs'])
    expect(caps(wf({ steps: [codeStep('a', 'await $.flow.delay(1000)')] }))).toEqual(['long_runs'])
    expect(caps(wf({ settings: { auto_retry: true } }))).toEqual(['long_runs'])
    expect(caps(wf({ settings: { concurrency: 1 } }))).toEqual(['long_runs'])
    expect(caps(wf({ steps: [codeStep('a', 'return $.flow.rerun(5000)')] }))).toEqual(['long_runs'])
    expect(caps(wf({ steps: [codeStep('a', 'await axios.post("https://eoabc123.m.pipedream.net", body)')] }))).toEqual(['long_runs'])
  })

  it('needs request access when an HTTP workflow reads headers, the query, the method or the raw body', () => {
    for (const ref of ['steps.trigger.event.headers["x-api-key"]', 'steps.trigger.event.query.id', 'steps.trigger.event.method', 'steps.trigger.event.bodyRaw']) {
      expect(caps(wf({ steps: [codeStep('a', ref)] })), ref).toEqual(['request_access'])
    }
    expect(caps(wf({ steps: [registryStep('a', 'http-custom-request', { url: '{{steps.trigger.event.query.lead}}' })] }))).toEqual(['request_access'])
    expect(caps(wf({ triggers: [{ type: 'timer' }], steps: [codeStep('a', 'steps.trigger.event.headers')] }))).toEqual(['schedules'])
  })

  it('reports a timeout raised past 30 seconds without counting it as a need', () => {
    const raised = workflowNeeds(wf({ settings: { lambda_timeout: 90 } }))
    expect([...raised.needs.keys()]).toEqual([])
    expect(raised.raisedTimeoutSeconds).toBe(90)
    expect(workflowNeeds(wf({ settings: { lambda_timeout: 30 } })).raisedTimeoutSeconds).toBeNull()
  })

  it('reads deployment steps as well as top level ones', () => {
    expect(caps(wf({ deployments: { d_1: { steps: [registryStep('a', 'gmail-send-email')] } } }))).toEqual(['connections'])
  })

  it('records evidence for each need and the side facts the table reports', () => {
    const n = workflowNeeds(wf({
      name: 'Partner Bidding PROD',
      triggers: [{ type: 'http' }, { type: 'timer' }],
      steps: [registryStep('a', 'http-custom-request', { httpRequest: '<redacted>' }), registryStep('b', 'equifax-credit-report'), codeStep('c', 'props: { _filter: {} }')],
    }))
    expect(n.needs.get('connections')).toEqual(['step equifax-credit-report'])
    expect(n.needs.get('schedules')).toEqual(['trigger timer'])
    expect(n.redactedHttpSteps).toBe(1)
    expect(n.multiTrigger).toBe(true)
    expect(n.filterRules).toBe(true)
    expect(n.biddingSignals).toEqual(['name', 'step equifax-credit-report'])
  })
})
