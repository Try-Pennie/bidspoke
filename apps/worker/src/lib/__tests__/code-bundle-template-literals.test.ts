/**
 * The bundler indents each script into its wrapper function. A line INSIDE a template literal
 * is part of the string's value, so indenting it changes what the script returns (#1636): the
 * Liberty1 click patch wrote its TCPA disclosure to Salesforce with six stray spaces at the
 * start of every line after the first, so the stored consent text was not what the person
 * agreed to.
 *
 * These load the REAL built bundle through a data: import and run it, so they assert the value
 * the script actually returns in the sandbox, not a reading of the generated source.
 */
import { describe, it, expect } from 'vitest'
import { buildBundledWorkerScript } from '../code-node-deployer'
import { KEPT_LIBERTY1_CLICK_SCRIPTS } from '../engine-script-drift'
import { LIBERTY1_TCPA } from '../../engine/scripts/__tests__/liberty1-pipedream-oracle'

type Handler = { fetch(request: Request): Promise<Response> }

async function loadBundle(scripts: Array<{ namespace: string; script: string }>): Promise<Handler> {
  const source = buildBundledWorkerScript(scripts)
  const mod = (await import(/* @vite-ignore */ `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)) as { default: Handler }
  return mod.default
}

async function run(script: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const handler = await loadBundle([{ namespace: 'step', script }])
  const res = await handler.fetch(new Request('https://worker/execute/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: {}, steps: {}, env: {}, execution: {}, props: {}, ...body }),
  }))
  const envelope = await res.json() as { output?: unknown; error?: string }
  if (envelope.error) throw new Error(envelope.error)
  return envelope.output
}

describe('bundled code step template literals (#1636)', () => {
  it('returns the Liberty1 TCPA disclosure byte for byte, as the kept click patch writes it', async () => {
    const patch = KEPT_LIBERTY1_CLICK_SCRIPTS.find((s) => s.namespace === 'click_patch')
    if (!patch) throw new Error('no kept click_patch script')
    const output = await run(patch.script, {
      steps: { click_send: { output: { _route: 'sent', partner_lead_id: 'a0B000000000001AAA' } } },
      execution: { bidspoke_link: 'https://bidspoke.example/executions/1' },
    }) as { prospect: Record<string, unknown>; submission: Record<string, unknown>; lead: Record<string, unknown> }
    expect(output.prospect.TCPA_Consent__c).toBe(LIBERTY1_TCPA)
    expect(output.submission.External_TCPA_Consent__c).toBe(LIBERTY1_TCPA)
    expect(output.lead.TCPAConsent__c).toBe(LIBERTY1_TCPA)
  })

  it('keeps every line of a multi-line template byte identical, leading spaces and blank lines included', async () => {
    const text = 'first\n  two leading spaces\n\n\tone tab\nlast'
    const script = `const t = \`${text}\`\nreturn { t }`
    expect(await run(script)).toEqual({ t: text })
  })

  it('keeps a template byte identical when a ${} inside it holds a nested backtick string', async () => {
    const script = [
      'const who = "Ada"',
      'const t = `hello',
      '  ${who ? `dear ${who}` : `nobody`}',
      '  and more`',
      'return { t }',
    ].join('\n')
    expect(await run(script)).toEqual({ t: 'hello\n  dear Ada\n  and more' })
  })

  it('keeps a template byte identical when a ${} spans lines with an object literal inside it', async () => {
    const script = [
      'const t = `a',
      '${JSON.stringify({',
      '  k: 1,',
      '})}',
      'b`',
      'return { t }',
    ].join('\n')
    expect(await run(script)).toEqual({ t: 'a\n{"k":1}\nb' })
  })

  it('still indents the lines outside a template, including the one after it closes', () => {
    const script = 'const t = `x\ny`\nconst z = 1\nreturn { t, z }'
    const source = buildBundledWorkerScript([{ namespace: 'step', script }])
    expect(source).toContain('      const t = `x\ny`\n      const z = 1\n      return { t, z }\n')
  })

  it('indents every line of a script with no template literal exactly as before', () => {
    const script = "const a = 'x'\n// a comment holding a stray ` backtick\nconst b = \"y\"\nreturn { a, b }"
    const source = buildBundledWorkerScript([{ namespace: 'step', script }])
    const expected = script.split('\n').map((l) => `      ${l}`).join('\n')
    expect(source).toContain(`props = props || {}\n${expected}\n    },`)
  })
})
