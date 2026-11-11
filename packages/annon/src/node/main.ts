#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { createAdapter } from './adapter.js';
import { runCli } from './cli.js';

const adapter = createAdapter(process.env, {
  ...(process.stdin.isTTY && process.stderr.isTTY
    ? {
        prompt: async (message: string) => {
          const reader = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return (await reader.question(message)).trim().toLowerCase() === 'yes';
          } finally {
            reader.close();
          }
        },
      }
    : {}),
  notify: (message) => process.stderr.write(`${message}\n`),
});
process.exitCode = await runCli(process.argv.slice(2), adapter, (text) =>
  process.stdout.write(`${text}\n`),
);
