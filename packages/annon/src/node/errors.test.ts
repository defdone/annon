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
