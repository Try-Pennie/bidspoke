export interface SchemaField {
  name: string
  label: string
  type: string
  nullable?: boolean
}

export interface SchemaObject {
  name: string
  label: string
  fields: SchemaField[]
}

export interface SchemaCache {
  objects: SchemaObject[]
}
