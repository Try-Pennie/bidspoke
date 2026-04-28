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
    public readonly suppressAlert: boolean
  ) {
    super(message)
  }
}
