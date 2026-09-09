import type { ErrorType } from '../types'

/**
 * Thrown by the partner-bid node (and bid-resolver) when a partner API call fails.
 * Carries the pre-determined error classification and alert suppression flag
 * so the engine doesn't need to re-classify or look up the partner config.
 */
export class PartnerApiError extends Error {
  constructor(
    message: string,
    public readonly errorType: ErrorType,
    public readonly suppressAlert: boolean,
    /**
     * True when the failure is OUR configuration being wrong (a declared credential
     * that is unset or blank), rather than anything the partner did. The circuit
     * breaker exists to detect an upstream outage, so a fault on our side must not
     * count toward its error threshold: charging it there opens the breaker and
     * turns every later lead into a generic 'circuit_open' skip, burying the precise
     * reason (#411, #417).
     *
     * This is deliberately NOT the same question as `errorType === 'permanent'`. A
     * permanent 4xx from the partner is genuine upstream signal and must keep
     * counting; only a fault we caused is exempt (L615).
     */
    public readonly isConfigError: boolean = false
  ) {
    super(message)
  }
}
