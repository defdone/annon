/** The error a sell or share throws, carrying the file ID to resume with. */
import { SourceChangedError } from '../envelope/stream.js';
import { AnnonError, toPublicError } from '../errors.js';

export class SellError extends AnnonError {
  readonly txHash?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly fileId: string,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause;
    const code =
      cause instanceof AnnonError || cause instanceof SourceChangedError
        ? cause.code
        : 'sell_incomplete';
    super(
      code,
      cause instanceof Error ? cause.message : 'Sell incomplete; resume with fileId.',
      options,
    );
    this.name = 'SellError';
    const safe = toPublicError(cause);
    if (safe.retryAfterSeconds !== undefined) this.retryAfterSeconds = safe.retryAfterSeconds;
    if (cause instanceof AnnonError && 'txHash' in cause && typeof cause.txHash === 'string')
      this.txHash = cause.txHash;
  }
}
