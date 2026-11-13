import { expect, it } from 'vitest';
import * as browser from './browser/index.js';
import { AnnonError, isTransient, toPublicError } from './errors.js';
import * as root from './index.js';
import { BudgetError } from './node/budget.js';
import { AdapterError } from './node/errors.js';
import { RelayError } from './relay/relay.js';

it.each([
  ['PayError', ['transport']],
  ['SourceChangedError', []],
  ['Pay2Error', ['bad_header']],
  ['DownloadError', ['transport']],
  ['CkdError', ['ckd_failed']],
  ['NearError', ['transport']],
  ['BaseRpcRateLimited', []],
  ['NearRpcRateLimited', []],
  ['TransactionUncertain', ['transaction', `0x${'11'.repeat(32)}`]],
  ['FileFundingRefused', []],
  ['OneClickQuoteExpired', []],
  ['OneClickRefused', ['No routes found']],
  ['SellError', [`0x${'22'.repeat(32)}`]],
  ['BrowserWalletError', ['rejected', 'Rejected']],
  ['PurchaseLeaseBusy', [100]],
] as const)('exports a named %s from both browser-safe entries', (name, args) => {
  for (const entry of [root, browser]) {
    const Class = entry[name] as new (...args: unknown[]) => Error;
    const error = new Class(...args);
    expect(error).toBeInstanceOf(AnnonError);
    expect(error.name).toBe(name);
  }
});

it('names node and service subclasses and never leaves SellError.code undefined', () => {
  for (const error of [
    new AnnonError('internal'),
    new AdapterError('bad_request', 'safe'),
    new BudgetError(),
    new RelayError('bad_request'),
  ]) {
    expect(error).toBeInstanceOf(AnnonError);
    expect(error.name).toBe(error.constructor.name);
  }
  expect(new root.SellError(`0x${'22'.repeat(32)}`).code).toBe('sell_incomplete');
});

it.each([
  new root.PayError('transport'),
  new root.BaseRpcRateLimited(),
  new root.NearRpcRateLimited(),
])('treats each transport or RPC limit as transient: %s', (error) => {
  expect(isTransient(error)).toBe(true);
});
it.each([null, new Error('transport'), { code: 'refused' }, { code: 'settlement_pending' }])(
  'does not retry refusals or infer transience from text',
  (error) => {
    expect(isTransient(error)).toBe(false);
  },
);
it('assigns distinct RPC codes and quote refusal code', () => {
  expect(new root.BaseRpcRateLimited().code).toBe('base_rpc_rate_limited');
  expect(new root.NearRpcRateLimited().code).toBe('near_rpc_rate_limited');
  expect(new root.OneClickRefused('No routes found').code).toBe('quote_refused');
});
it('sanitizes unknown exceptions and validates public evidence', () => {
  expect(toPublicError(new Error('PRIVATE_UPSTREAM'))).toMatchObject({
    code: 'operation_failed',
    exitCode: 1,
  });
  const id = `0x${'11'.repeat(32)}`;
  const safe = toPublicError(
    Object.assign(new AnnonError('settlement_pending', 'PRIVATE_UPSTREAM'), {
      fileId: id,
      purchaseId: id,
      txHash: 'hash',
      retryAfterSeconds: 1.1,
      private: 'secret',
    }),
  );
  expect(safe).toEqual({
    code: 'settlement_pending',
    message: expect.any(String),
    exitCode: 4,
    fileId: id,
    purchaseId: id,
    txHash: 'hash',
    retryAfterSeconds: 2,
  });
  expect(JSON.stringify(safe)).not.toContain('PRIVATE_UPSTREAM');
  expect(toPublicError(new AnnonError('settlement_pending'))).toMatchObject({
    retryAfterSeconds: 30,
  });
  for (const code of ['settling', 'settlement_processing', 'payment_not_safe', 'oneclick_refused'])
    expect(toPublicError({ code }).code).toBe('operation_failed');
});

it('omits all evidence from an unrecognized exception', () => {
  expect(
    toPublicError({
      code: 'unrecognized',
      txHash: 'PRIVATE_UPSTREAM',
      minimumAmountUsdc: '1',
      retryAfterSeconds: 0,
    }),
  ).toEqual({ code: 'operation_failed', message: expect.any(String), exitCode: 1 });
});

it.each(['1e2', '-1', '00.1', '', 'PRIVATE_UPSTREAM'])(
  'omits an invalid quote minimum %s',
  (minimumAmountUsdc) => {
    const safe = toPublicError(
      Object.assign(new AnnonError('quote_refused'), { minimumAmountUsdc }),
    );
    expect(safe).not.toHaveProperty('minimumAmountUsdc');
  },
);

it('reports changed sources with the frozen code', () => {
  expect(new root.SourceChangedError().code).toBe('source_changed');
});

it('prints the source-change resume instruction once, including a sell wrapper', () => {
  for (const error of [
    new root.SourceChangedError(),
    new root.SellError(`0x${'22'.repeat(32)}`, { cause: new root.SourceChangedError() }),
  ]) {
    expect(
      toPublicError(error).message.match(
        /Resume sell with the original plaintext and saved fileId\./g,
      ),
    ).toHaveLength(1);
  }
});

it('reports route refusal with the exact safe message and exit 2', () => {
  for (const error of [
    new AnnonError('route_unavailable', 'PRIVATE'),
    new AdapterError('route_unavailable', 'PRIVATE', 1),
  ])
    expect(toPublicError(error)).toEqual({
      code: 'route_unavailable',
      message: 'This file does not support the selected payment route.',
      exitCode: 2,
    });
});
