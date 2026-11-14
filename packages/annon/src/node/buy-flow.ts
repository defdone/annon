/**
 * `buy` followed through to the file: wait until NEAR accepts the purchase, then open it. Every
 * step is a full adapter command, so trust, policy and purchase state are checked as in one-shot
 * `status` and `open`. Nothing here pays or retries a payment.
 */
import type { PublicError } from '../errors.js';
import type { Input } from './cli.js';
import { commonInput } from './cli-flags.js';
import { publicError } from './errors.js';
import { newOutput } from './io.js';

export interface BuyFollow {
  notify?: (message: string) => void;
  /** Pause between status checks; resolves early when `signal` aborts. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborting stops the waiting only. The saved purchase is left as it is. */
  signal?: AbortSignal;
  /** Asked once the purchase is accepted and no `--open` path was given. */
  savePath?: () => Promise<string | undefined>;
  onWaiting?: (waiting: boolean) => void;
}
type Execute = (input: Input) => Promise<unknown>;
type Result = Record<string, unknown>;

const CHECKS = 60;
const INTERVAL_MS = 3000;
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** Status checks until the purchase is accepted, the checks run out or the wait is cancelled. */
async function accepted(execute: Execute, input: Input, id: string, o: BuyFollow) {
  o.onWaiting?.(true);
  try {
    for (let check = 0; check < CHECKS && !o.signal?.aborted; check++) {
      if (check > 0) await (o.wait ?? pause)(INTERVAL_MS, o.signal);
      if (o.signal?.aborted) break;
      const status = (await execute({
        ...commonInput(input),
        command: 'status',
        target: id,
      })) as Result;
      if (status.state === 'accepted') return true;
    }
    return false;
  } finally {
    o.onWaiting?.(false);
  }
}

/**
 * Runs one command. A `buy` is followed when the caller is a person (`follow`) or asked for
 * `--open`; a deposit route returns its instructions without waiting.
 */
export async function buyFlow(
  input: Input,
  execute: Execute,
  follow: boolean,
  o: BuyFollow = {},
): Promise<unknown> {
  if (input.command !== 'buy' || (!follow && input.open === undefined)) return execute(input);
  // Refuse a taken output name before any payment step.
  if (input.open !== undefined) await newOutput(input.open);
  const bought = (await execute(input)) as Result;
  const id = bought.purchaseId;
  if (typeof id !== 'string' || !['submitted', 'uncertain'].includes(String(bought.state)))
    return bought;
  o.notify?.(
    bought.state === 'uncertain'
      ? 'The wallet may have sent this payment. Do not pay again. Checking NEAR...'
      : 'Payment sent. Waiting for NEAR to accept...',
  );
  // From here the payment exists: a later failure is reported next to the purchase, never instead.
  const pending = (statusError?: PublicError): Result => ({
    ...bought,
    settlement: 'pending',
    ...(statusError ? { statusError } : {}),
    next: `Not accepted yet. Do not pay again. Run annon status ${id} until it is accepted, then annon open ${id} --output <file>.`,
  });
  try {
    if (!(await accepted(execute, input, id, o))) return pending();
  } catch (error) {
    return pending(publicError(error));
  }
  const settled = { ...bought, state: 'accepted', next: `annon open ${id} --output <file>` };
  const output = input.open ?? (await o.savePath?.());
  if (!output) return settled;
  try {
    const opened = (await execute({
      ...commonInput(input),
      command: 'open',
      target: id,
      output,
    })) as Result;
    return {
      ...bought,
      state: 'opened',
      opened: { output: opened.output, bytes: opened.bytes },
      next: 'The file is saved.',
    };
  } catch (error) {
    return { ...settled, openError: publicError(error) };
  }
}
