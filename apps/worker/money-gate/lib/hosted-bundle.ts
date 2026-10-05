/**
 * A code bundle the gate hosts for the replay (#1704, #1708 part B), shared by
 * the replay (in workerd) and the GATE_IO service (in Node), so it holds no
 * import either side cannot load. The same name in two namespaces is two
 * scripts, as on the platform.
 */
export interface HostedBundle {
  name: string
  script: string
  /** The dispatch namespace it is deployed in. */
  namespace: string
}
