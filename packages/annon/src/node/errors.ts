import { AnnonError, type AnnonErrorCode, type PublicError, toPublicError } from '../errors.js';

/** Adapter-authored messages and exit codes are safe to display to the caller. */
export class AdapterError extends AnnonError {
  readonly exitCode: PublicError['exitCode'];
  constructor(code: AnnonErrorCode, message: string, exitCode: PublicError['exitCode'] = 1) {
    super(code, message);
    this.exitCode = exitCode;
    this.name = 'AdapterError';
  }
}
export const usage = () =>
  new AdapterError('invalid_arguments', 'Invalid arguments. Run annon --help.', 2);
export const publicError = toPublicError;
