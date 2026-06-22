import type { SchemaCache, SchemaObject, SchemaField } from './types'
import { parseJson } from '../json'

interface SalesforceCredentials {
  access_token: string
  instance_url: string
}

// Describe these objects — fetching all would be too slow and noisy
const CORE_OBJECTS = ['Lead', 'Contact', 'Account', 'Opportunity', 'Case', 'Task', 'Event']

export async function fetchSalesforceSchema(credsJson: string): Promise<SchemaCache> {
  const { access_token, instance_url } = JSON.parse(credsJson) as SalesforceCredentials
  const headers = { Authorization: `Bearer ${access_token}` }
  const base = `${instance_url}/services/data/v59.0`

  // List available SObjects
  const listRes = await fetch(`${base}/sobjects/`, { headers })
  if (!listRes.ok) throw new Error(`Salesforce SObject list failed (${listRes.status})`)
  const list = await parseJson<{ sobjects: Array<{ name: string; label: string; queryable: boolean }> }>(listRes)

  const targets = list.sobjects.filter((o) => o.queryable && CORE_OBJECTS.includes(o.name))

  const objects: SchemaObject[] = await Promise.all(
    targets.map(async (obj) => {
      const descRes = await fetch(`${base}/sobjects/${obj.name}/describe/`, { headers })
      if (!descRes.ok) return { name: obj.name, label: obj.label, fields: [] }
      const desc = await parseJson<{
        fields: Array<{ name: string; label: string; type: string; nillable: boolean }>
      }>(descRes)
      const fields: SchemaField[] = desc.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        nullable: f.nillable,
      }))
      return { name: obj.name, label: obj.label, fields }
    })
  )

  return { objects }
}
