/** Only these adapter-owned messages cross the CLI/MCP boundary. Never print upstream errors. */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
export const usage = () =>
  new AdapterError('invalid_arguments', 'Invalid arguments. Run annon --help.', 2);
const actions: Record<string, string> = {
  unknown_file: 'The configured contract has no such file. Check the file ID and deployment.',
  taken_down: 'The moderator has taken down this file; key release is blocked.',
  sales_stopped:
    'The seller has stopped new sales. Use a saved purchase to open an earlier purchase.',
  unknown_moderator:
    "Review this file's moderator and explicitly accept it with the moderator option before buying.",
  price_above_max: 'The registered price exceeds maxPrice. Review the current terms before buying.',
  untrusted_contract:
    'The offer names a different contract. Review that deployment and configure it explicitly.',
  network_mismatch:
    'The deployment network or USDC asset differs from the configured network. Check the configuration.',
  store_conflict:
    'Another process updated this purchase. Keep the encrypted state and check status before retrying.',
  file_invalid: 'The file failed SDK verification. Obtain the registered file from its host.',
  file_mismatch:
    'The file or offer differs from its registered commitment. Obtain the correct file or offer.',
  bad_requirements: 'The host offer failed SDK validation. Obtain an updated Annon offer.',
  payment_not_safe:
    'Base settlement is not safe yet. Keep the saved purchase and retry opening after finality advances.',
  settling:
    'The purchase is still settling. Keep the saved purchase and check status before opening again.',
  not_authorized:
    'The host has not accepted this final grant. Check final purchase status and the resource URL.',
};
export function publicError(error: unknown): { code: string; message: string; exitCode: number } {
  if (error instanceof AdapterError)
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const message = Object.hasOwn(actions, error.code) ? actions[error.code] : undefined;
    if (message) return { code: error.code, message, exitCode: 1 };
  }
  return {
    code: 'operation_failed',
    message:
      'Operation failed. Check configuration, funding and final purchase status before retrying. Saved encrypted records are retained.',
    exitCode: 1,
  };
}
