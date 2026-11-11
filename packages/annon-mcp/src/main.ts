#!/usr/bin/env node
import { publicError } from '@defdone/annon/node/errors';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

try {
  await createServer().connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
}
