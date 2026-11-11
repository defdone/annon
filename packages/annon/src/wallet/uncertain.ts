/** Public evidence to retain whenever a submitted NEAR transaction cannot be confirmed. */
export class TransactionUncertain extends Error {
  readonly code = 'transaction_uncertain';
  constructor(
    readonly txHash: string,
    readonly purchaseId?: string,
  ) {
    super(
      'Transaction submission is uncertain. Check the saved purchase and transaction hash before retrying.',
    );
  }
}
