import { expect, it } from 'vitest';
import { NearError } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { publicError } from './errors.js';

it.each([
  new PayError('transport', 'Base RPC rate limited (429)'),
  new NearError('transport', 'NEAR RPC rate limited (429)'),
])('does not identify a rate limit from message text alone', (error) => {
  expect(publicError(error).code).toBe('operation_failed');
  expect(publicError(error).message).not.toContain(error.message);
});
