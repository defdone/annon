#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { createAdapter } from './adapter.js';
import { runCli } from './cli.js';
import { createSession } from './shell/session.js';
import { humanOutput, sessionAllowed, welcome } from './shell/welcome.js';

const argv = process.argv.slice(2);
const notify = (message: string) => process.stderr.write(`${message}\n`);
if (
  await sessionAllowed(
    argv,
    process.stdin.isTTY === true && process.stdout.isTTY === true,
    process.env,
  )
) {
  const session = createSession({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    welcome: await welcome(process.env),
    adapter: (hooks) => createAdapter(process.env, { ...hooks, human: true }),
  });
  // A confirmed Ctrl-C leaves a command running; exiting ends it as it would end a one-shot run.
  process.exit(await session.run());
}
const human = await humanOutput(process.stdout.isTTY === true, process.env);
const adapter = createAdapter(process.env, {
  human,
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
  notify,
});
process.exitCode = await runCli(argv, adapter, (text) => process.stdout.write(`${text}\n`), {
  human,
  notify,
});
