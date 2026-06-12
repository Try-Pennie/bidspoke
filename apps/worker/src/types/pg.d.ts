// Minimal ambient declaration for the subset of `node-postgres` (pg) we use in
// pg-writer.ts. We deliberately avoid @types/pg because it pulls in @types/node,
// which conflicts with the Workers type environment (tsconfig `types` is pinned
// to @cloudflare/workers-types). pg is loaded via a dynamic import that only
// runs when the Hyperdrive binding is present, so it never executes under the
// default (PostgREST-only) configuration.
declare module 'pg' {
  export class Client {
    constructor(config: { connectionString: string })
    connect(): Promise<void>
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>
    end(): Promise<void>
  }
}
