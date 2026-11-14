/** A session on in-memory streams for the interactive CLI tests. */
import { PassThrough } from 'node:stream';
import { expect, vi } from 'vitest';
import type { Input } from '../src/node/cli.js';
import type { Dependencies } from '../src/node/command-context.js';
import { createSession } from '../src/node/shell/session.js';

export type Hooks = Pick<Dependencies, 'prompt' | 'notify'>;
export type Adapter = (input: Input, hooks: Hooks) => Promise<Record<string, unknown>>;

/** `type` sends a line; `shown` waits for text to appear; `calls` is what reached the adapter. */
export function session(adapter: Adapter, terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += String(chunk);
  });
  const calls: Input[] = [];
  const s = createSession({
    input,
    output,
    welcome: 'Annon test',
    terminal,
    wait: async () => {},
    adapter: (hooks) => (o) => {
      calls.push(o);
      return adapter(o, hooks);
    },
  });
  const exit = s.run();
  return {
    calls,
    exit,
    interrupt: s.interrupt,
    type: (line: string) => input.write(`${line}\n`),
    keys: (keys: string) => input.write(keys),
    end: () => input.end(),
    text: () => text,
    shown: (part: string) => vi.waitFor(() => expect(text).toContain(part)),
    /** Waits until the prompt has been printed `count` times: that many commands are done. */
    prompts: (count: number) =>
      vi.waitFor(() => expect(text.split('annon> ').length - 1).toBe(count)),
  };
}
