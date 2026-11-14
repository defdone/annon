/**
 * The interactive session: one prompt, the one-shot commands without the `annon` prefix. Every
 * line goes through `runCli` and the adapter exactly as a one-shot command does; the session adds
 * the prompt, a memory of the last catalog listing, and Ctrl-C handling. It keeps no config, wallet,
 * secret or purchase between commands: `status` and `open` without an ID reach the adapter as
 * typed, and it finds the latest purchase saved for the contract and network of that line.
 */
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { CatalogEntry } from '../../shops/discovery.js';
import { isRow } from '../adapter-checks.js';
import { type Input, runCli } from '../cli.js';
import type { Dependencies } from '../command-context.js';
import { AdapterError, publicError } from '../errors.js';
import { rowNumber } from '../output/discovery.js';
import { humanError } from '../output/human.js';
import { cleanText } from '../output/text.js';
import { complete } from './complete.js';
import { splitWords } from './words.js';

type Execute = (input: Input) => Promise<Record<string, unknown>>;
export interface SessionOptions {
  input: Readable;
  output: Writable;
  /** Line editing and Tab completion; off for a plain stream. */
  terminal?: boolean;
  welcome: string;
  /** Builds the adapter with the session's prompt and notices. */
  adapter: (hooks: Pick<Dependencies, 'prompt' | 'ask' | 'notify'>) => Execute;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Commands that can move money or send a transaction; leaving in the middle needs a yes. */
const paying = ['buy', 'fund', 'sell', 'share', 'stop', 'recover'];
/** Commands that only read: Ctrl-C drops their result and returns to the prompt. */
const reading = ['shops', 'catalog', 'status', 'verify', 'budget'];
const HELP = `Commands work as on the command line, without the annon prefix:
  login                      sign in with a browser wallet
  shops, shop add <url>      list and add shops
  catalog [--shop <id>]      list a shop's files, numbered
  buy <#|url> [--open <file>]  buy a row of the last catalog, or a URL
  status [id]                check a purchase (default: the latest saved for this contract)
  open [id] --output <file>  save a bought file (default: the same latest purchase)
  init, verify, recover, sell, share, fund, budget, stop
  <command> --help           every command and option
  exit, quit or Ctrl-D       leave
  Ctrl-C                     answers a prompt with no, drops a listing or status result, stops
                             a wait for acceptance, and asks before leaving a running payment`;

export function createSession(o: SessionOptions) {
  const rl = createInterface({
    input: o.input,
    output: o.output,
    terminal: o.terminal === true,
    completer: complete,
    prompt: 'annon> ',
  });
  const say = (text: string) => o.output.write(`${text}\n`);
  const queue: string[] = [];
  /** The catalog listing on screen, by row number; none until `catalog` has run. */
  let rows: Map<number, CatalogEntry> | undefined;
  let question: AbortController | undefined;
  let running:
    | { command: string; waiting: boolean; live: boolean; stop: AbortController; drop: () => void }
    | undefined;
  let busy = false;
  let closed = false;
  let finish: (code: number) => void = () => {};
  const ended = new Promise<number>((resolve) => {
    finish = resolve;
  });

  /** One question at a time. Ctrl-C or a closed input answers nothing, which every caller reads as no. */
  let asking: Promise<unknown> = Promise.resolve();
  const ask = (message: string): Promise<string | undefined> => {
    const answer = asking.then(async () => {
      question = new AbortController();
      try {
        return (await rl.question(message, { signal: question.signal })).trim();
      } catch {
        return undefined;
      } finally {
        question = undefined;
      }
    });
    asking = answer;
    return answer;
  };

  const adapter = o.adapter({
    prompt: async (message) => (await ask(message))?.toLowerCase() === 'yes',
    ask,
    notify: say,
  });
  /** The adapter call of a session line, with a row number of the listing on screen filled in. */
  const execute: Execute = async (input) => {
    let next = input;
    // A number means a row of the listing on screen. Without one, or with --shop, the adapter
    // reads the catalog itself, as for a one-shot `buy <row> --shop <id>`.
    if (input.command === 'buy' && isRow(input.target) && input.shop === undefined && rows) {
      const row = rows.get(Number(input.target));
      if (!row)
        throw new AdapterError(
          'invalid_arguments',
          `Row ${input.target} is not in the last catalog listing. Run catalog again.`,
          2,
        );
      say(`Row ${input.target}: ${cleanText(row.title)} (${row.url})`);
      const { search: _search, ...rest } = input;
      next = { ...rest, target: row.url };
    }
    const owner = running;
    const result = await adapter(next);
    // A command dropped with Ctrl-C printed nothing, so it must not change what a row number means.
    if (!owner?.live) return result;
    if (input.command === 'catalog' && Array.isArray(result.items))
      rows = new Map(
        (result.items as CatalogEntry[]).map((entry, i) => [rowNumber(input, i), entry]),
      );
    return result;
  };

  async function command(words: string[]) {
    const current = {
      command: words.find((word) => !word.startsWith('-')) ?? '',
      waiting: false,
      live: true,
      stop: new AbortController(),
      drop: () => {},
    };
    const dropped = new Promise<void>((resolve) => {
      current.drop = resolve;
    });
    running = current;
    const done = runCli(words, execute, (text) => current.live && say(text), {
      human: true,
      notify: (message) => current.live && say(message),
      signal: current.stop.signal,
      onWaiting: (waiting) => {
        current.waiting = waiting;
      },
      savePath: async () => (await ask('Save the file now? Path (Enter to skip): ')) || undefined,
      ...(o.wait ? { wait: o.wait } : {}),
    });
    await Promise.race([done, dropped]);
    running = undefined;
    // An exit question left open by Ctrl-C is moot once the command is over.
    question?.abort();
  }

  async function line(text: string): Promise<boolean> {
    let words: string[];
    try {
      words = splitWords(text);
    } catch (error) {
      say(humanError(publicError(error)));
      return false;
    }
    if (words[0] === 'annon') words.shift();
    if (words.length === 0) return false;
    if (words.length === 1 && ['exit', 'quit'].includes(words[0] as string)) return true;
    if (words.length === 1 && words[0] === 'help') say(HELP);
    else if (words[0] === 'shell') say('This is the session already.');
    else await command(words);
    return false;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    let leave = false;
    while (!leave && queue.length > 0) leave = await line(queue.shift() as string);
    busy = false;
    if (leave || closed) {
      rl.close();
      finish(0);
    } else rl.prompt();
  }

  /** Ctrl-C. Never ends a paying command without a yes, and never touches saved purchase state. */
  async function interrupt() {
    if (question) {
      question.abort();
      say('');
      return;
    }
    if (!running) {
      // Drop what was typed; a plain stream has no line to edit.
      if (o.terminal) rl.write(null, { ctrl: true, name: 'u' });
      say('\n(type exit to leave)');
      rl.prompt();
      return;
    }
    const current = running;
    if (current.waiting) {
      say('Stopped waiting. The purchase is saved; check it with status.');
      current.stop.abort();
    } else if (reading.includes(current.command)) {
      current.live = false;
      say('Cancelled.');
      current.drop();
    } else {
      const answer = await ask(
        paying.includes(current.command)
          ? 'A payment may be in progress. Exit anyway? (y/N) '
          : `${current.command} is still running. Exit anyway? (y/N) `,
      );
      if (running === current && /^y(es)?$/i.test(answer ?? '')) {
        if (paying.includes(current.command))
          say(
            'Leaving. Nothing was removed: check the purchase with annon status before paying again.',
          );
        rl.close();
        finish(130);
      } else if (running === current) say('Still running.');
    }
  }

  rl.on('line', (text) => {
    queue.push(text);
    void pump();
  });
  rl.on('close', () => {
    closed = true;
    void pump();
  });
  rl.on('SIGINT', () => void interrupt());

  return {
    /** Resolves with the exit code once the person leaves: 0, or 130 after a confirmed Ctrl-C. */
    run(): Promise<number> {
      say(o.welcome);
      rl.prompt();
      return ended;
    },
    interrupt,
  };
}
