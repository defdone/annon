import { expect, it } from 'vitest';
import { NearError } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { AdapterError, publicError } from './errors.js';

it.each([{ code: 'payment_not_safe' }, new AdapterError('payment_not_safe', 'safe message', 4)])(
  'gives agents a retry interval for unsafe payments',
  (error) => {
    expect(publicError(error)).toMatchObject({ code: 'payment_not_safe', retryAfterSeconds: 30 });
    const message = publicError({ code: 'payment_not_safe' }).message;
    expect(message).toContain('one to three minutes');
    expect(message).toContain('status again in about 30 seconds');
  },
);

it.each([
  new PayError('transport', 'Base RPC rate limited (429)'),
  new NearError('transport', 'NEAR RPC rate limited (429)'),
])('does not identify a rate limit from message text alone', (error) => {
  expect(publicError(error).code).toBe('operation_failed');
  expect(publicError(error).message).not.toContain(error.message);
});

it.each([
  ['budget exhausted', 'The persisted spending budget is exhausted.', false],
  ['clock rollback', 'Clock moved backwards; spending is paused.', true],
] as const)('preserves the exact public message for %s', async (_name, message, rollback) => {
  const { reserveSpend } = await import('./budget.js');
  const { memoryStore } = await import('../pay/store.js');
  const store = memoryStore<import('./budget.js').BudgetRecord>();
  const at = 86400000;
  await reserveSpend(store, 'synthetic-budget', 10n, { daily: 10n }, at);
  const error = await reserveSpend(
    store,
    'synthetic-budget',
    1n,
    { daily: 10n },
    rollback ? 0 : at,
  ).catch((error) => error);
  expect(error.message).toBe(message);
  expect(publicError(error)).toEqual({ code: 'budget_exceeded', message, exitCode: 1 });
});
