import { expect, it, vi } from 'vitest';
import { checkAdmissionFloor } from './admission.js';

it('refuses seller and listing writes below the liquid floor and de-duplicates floor transitions', async () => {
  const alert = vi.fn();
  let balance = 2n * 10n ** 24n;
  const options = { admissionFloor: 3n * 10n ** 24n, admissionBalance: async () => balance, alert };
  for (const method of ['register', 'fund_file_storage', 'reopen_seller', 'stop_sales'])
    await expect(checkAdmissionFloor(method, options)).rejects.toMatchObject({
      code: 'budget',
      retryAt: expect.any(Number),
    });
  expect(alert).toHaveBeenCalledExactlyOnceWith('admissions_paused');
  for (const method of ['unlock', 'claim_key', 'reopen'])
    await expect(checkAdmissionFloor(method, options)).resolves.toBeUndefined();
  balance = 3n * 10n ** 24n;
  await checkAdmissionFloor('register', options);
  await checkAdmissionFloor('fund_file_storage', options);
  expect(alert.mock.calls).toEqual([['admissions_paused'], ['admissions_resumed']]);
  balance = 0n;
  await expect(checkAdmissionFloor('register', options)).rejects.toMatchObject({ code: 'budget' });
  expect(alert.mock.calls).toHaveLength(3);
});
it('fails closed when a configured floor cannot be read while paid unlocks bypass the read', async () => {
  const read = vi.fn(async () => {
    throw new Error('private upstream');
  });
  const options = { admissionFloor: 1n, admissionBalance: read };
  await expect(checkAdmissionFloor('register', options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
  for (const method of ['unlock', 'claim_key', 'reopen'])
    await expect(checkAdmissionFloor(method, options)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
});
it('computes liquid funds from one final account and the matching protocol storage price', async () => {
  const rpc = await import('../near/rpc.js');
  const { admissionBalance } = await import('./admission.js');
  const spy = vi.spyOn(rpc, 'rpcReply');
  try {
    spy.mockImplementation(
      async (_url, method) =>
        ({
          result:
            method === 'query'
              ? { amount: '10000', locked: '1000', storage_usage: 1000, block_hash: 'final-block' }
              : { runtime_config: { storage_amount_per_byte: '2' } },
        }) as never,
    );
    expect(await admissionBalance('https://near.invalid', 'relay.test')).toBe(9000n);
    expect(spy).toHaveBeenCalledWith('https://near.invalid', 'EXPERIMENTAL_protocol_config', {
      block_id: 'final-block',
    });
    spy.mockResolvedValue({ error: { code: -1 } } as never);
    await expect(admissionBalance('https://near.invalid', 'relay.test')).rejects.toMatchObject({
      code: 'relayer_unavailable',
    });
  } finally {
    spy.mockRestore();
  }
});
