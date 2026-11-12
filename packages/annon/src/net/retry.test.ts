import { expect, it } from 'vitest';
import { parseRetryAfterMs, sleep } from './retry.js';

it('parses seconds and HTTP dates without truncating long waits', () => {
  expect(parseRetryAfterMs('900', 0)).toBe(900_000);
  expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:02 GMT', 500)).toBe(1500);
  for (const value of [null, '', '-1', '1.5', 'nonsense'])
    expect(parseRetryAfterMs(value, 0)).toBeUndefined();
});
it('aborts sleep immediately', async () => {
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(waiting).rejects.toThrow('cancelled');
  await expect(sleep(1, controller.signal)).rejects.toThrow('cancelled');
});
