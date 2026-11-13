import { AnnonError } from '../errors.js';
/** Public evidence to retain whenever a submitted NEAR transaction cannot be confirmed. */
export class TransactionUncertain extends AnnonError {
  readonly code = 'transaction_uncertain';
  constructor(
    readonly txHash: string,
    readonly purchaseId?: string,
  ) {
    super(
      'transaction_uncertain',
      'Transaction submission is uncertain. Check the saved purchase and transaction hash before retrying.',
    );
    this.name = 'TransactionUncertain';
  }
}
