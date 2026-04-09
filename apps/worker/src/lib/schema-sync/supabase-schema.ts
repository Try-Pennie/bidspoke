import type { SchemaCache, SchemaObject, SchemaField } from './types'

interface SupabaseCredentials {
  url: string
  service_role_key: string
}

interface OpenAPIDefinition {
  properties?: Record<string, { format?: string; type?: string }>
  required?: string[]
}

export async function fetchSupabaseSchema(credsJson: string): Promise<SchemaCache> {
  const { url, service_role_key } = JSON.parse(credsJson) as SupabaseCredentials

  // PostgREST exposes the OpenAPI spec at the root — includes all tables/views as definitions
  const res = await fetch(`${url}/rest/v1/`, {
    headers: {
      'apikey': service_role_key,
      'Authorization': `Bearer ${service_role_key}`,
    },
  })
  if (!res.ok) throw new Error(`Supabase schema fetch failed (${res.status})`)

  const spec = await res.json() as { definitions?: Record<string, OpenAPIDefinition> }

  const objects: SchemaObject[] = Object.entries(spec.definitions ?? {}).map(([name, def]) => {
    const required = new Set(def.required ?? [])
    const fields: SchemaField[] = Object.entries(def.properties ?? {}).map(([fieldName, prop]) => ({
      name: fieldName,
      label: fieldName,
      type: prop.format ?? prop.type ?? 'text',
      nullable: !required.has(fieldName),
    }))
    return { name, label: name, fields }
  })

  return { objects }
}
