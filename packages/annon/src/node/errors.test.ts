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

it.each([-0.1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'omits invalid download retry hints %s',
  async (hint) => {
    const { DownloadError } = await import('../download/download.js');
    const error = Object.assign(new DownloadError('download_limited'), {
      retryAfterSeconds: hint,
      fileId: 'private',
      purchaseId: 'private',
    });
    const result = publicError(error);
    expect(result).not.toHaveProperty('retryAfterSeconds');
    expect(result).not.toHaveProperty('fileId');
    expect(result).not.toHaveProperty('purchaseId');
    expect(result.exitCode).toBe(4);
  },
);
it('preserves rounded download retry evidence and pending exit code', async () => {
  const { DownloadError } = await import('../download/download.js');
  const id = `0x${'11'.repeat(32)}`;
  expect(
    publicError(
      Object.assign(new DownloadError('download_limited'), {
        retryAfterSeconds: 1.1,
        fileId: id,
        purchaseId: id,
      }),
    ),
  ).toMatchObject({
    code: 'download_limited',
    retryAfterSeconds: 2,
    fileId: id,
    purchaseId: id,
    exitCode: 4,
  });
});

it('reports a split RPC network mismatch as a configuration error', () => {
  expect(publicError(new PayError('network_mismatch'))).toMatchObject({
    code: 'network_mismatch',
    exitCode: 2,
  });
});
