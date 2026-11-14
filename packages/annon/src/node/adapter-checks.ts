/** Typed adapter failures and the file ID and backup path checks used by the CLI commands. */
import { join } from 'node:path';
import type { AnnonErrorCode, PublicError } from '../errors.js';
import type { Config } from './config.js';
import { AdapterError, usage } from './errors.js';

const fail = (code: AnnonErrorCode, message: string, exit: PublicError['exitCode'] = 1): never => {
  throw new AdapterError(code, message, exit);
};
const isId = (id: string) => /^0x[0-9a-f]{64}$/.test(id);
const backupPath = (c: Config, id: string) => {
  if (!/^(recovery:|sell:|seller-key:)?0x[0-9a-f]{64}(:revision:[0-9]+)?$/.test(id)) throw usage();
  return join(c.stateDir, 'backups', `${id.replaceAll(':', '-')}.json`);
};

export { backupPath, fail, isId };
