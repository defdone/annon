/** The installed package version; package.json sits two levels above both src/node and dist/node. */
import { createRequire } from 'node:module';

export const { version } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};
