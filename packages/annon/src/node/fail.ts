/** Throws a typed adapter error with a public code, message and exit code. */
import type { AnnonErrorCode, PublicError } from '../errors.js';
import { AdapterError } from './errors.js';

const fail = (code: AnnonErrorCode, message: string, exit: PublicError['exitCode'] = 1): never => {
  throw new AdapterError(code, message, exit);
};

export { fail };
