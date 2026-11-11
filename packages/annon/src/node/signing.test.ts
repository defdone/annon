import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { typedData } from '../pay/eip3009.js';
import { remoteSigner, signingRequest, verifySigningResult } from './signing.js';

const a = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const identity = { kind: 'evm' as const, id: a.address.toLowerCase() };
describe('versioned remote signer', () => {
  it('discovers, polls the same id, and checks the exact signature locally', async () => {
    const q = signingRequest('evm.personalSign', 'eip155:8453', identity.id, { message: 'exact' });
    const result = { signature: await a.signMessage({ message: 'exact' }) };
    const fetcher = vi.fn(async (url, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer credential' });
      if (String(url).endsWith('/v1/capabilities'))
        return Response.json({
          version: 1,
          account: q.account,
          chain: q.chain,
          operations: [q.operation],
        });
      return Response.json({
        version: 1,
        id: q.id,
        status: init?.method === 'POST' ? 'pending' : 'approved',
        result,
      });
    });
    const sign = remoteSigner({
      url: 'https://sign.example',
      credential: async () => 'credential',
      fetch: fetcher,
      wait: async () => {},
    });
    expect(await sign(q, (r) => verifySigningResult(q, r, 'https://rpc'))).toEqual(result);
    expect(fetcher.mock.calls[2]?.[0]).toBe(`https://sign.example/v1/requests/${q.id}`);
    await expect(
      verifySigningResult({ ...q, payload: { message: 'changed' } }, result, 'https://rpc'),
    ).rejects.toThrow();
  });
  it('verifies typed data and rejects substituted domain, chain and account', async () => {
    const data = typedData(`0x${'11'.repeat(20)}`, {
      from: identity.id,
      to: `0x${'22'.repeat(20)}`,
      value: 1n,
      validAfter: 0n,
      validBefore: 10n,
      nonce: `0x${'33'.repeat(32)}`,
    });
    const q = signingRequest('evm.signTypedData', 'eip155:8453', identity.id, data);
    const result = { signature: await a.signTypedData(data as never) };
    await verifySigningResult(q, result, 'https://rpc');
    await expect(
      verifySigningResult({ ...q, account: `0x${'00'.repeat(20)}` }, result, ''),
    ).rejects.toThrow();
    await expect(verifySigningResult({ ...q, chain: 'eip155:1' }, result, '')).rejects.toThrow();
  });
  it.each([
    'http://sign.example',
    'https://user:pass@sign.example',
    'https://sign.example/?token=x',
  ])('rejects unsafe signer URL %s', (url) => {
    expect(() => remoteSigner({ url, credential: async () => 'x' })).toThrow();
  });
  it('rejects wrong ids, expired approvals, rejections and redirects', async () => {
    const q = signingRequest('evm.personalSign', 'eip155:8453', identity.id, { message: 'x' });
    const fetcher = vi.fn(async () =>
      Response.json({ version: 1, id: 'other', status: 'approved', result: {} }),
    );
    await expect(
      remoteSigner({ url: 'https://sign.example', credential: async () => 'x', fetch: fetcher })(
        q,
        async () => {},
      ),
    ).rejects.toThrow();
    expect(fetcher.mock.calls).toHaveLength(1);
  });
});

it('reference adapter claims duplicate ids and rejects payload substitutions', async () => {
  const { signerMock } = await import('./signer-mock.js');
  const approve = vi.fn(async () => ({ signature: 'test' }));
  const handle = signerMock({
    credential: 'fake',
    account: identity.id,
    chain: 'eip155:8453',
    operations: ['evm.personalSign'],
    approve,
  });
  const q = signingRequest('evm.personalSign', 'eip155:8453', identity.id, { message: 'test' });
  const req = (body: unknown) =>
    new Request('https://mock/v1/requests', {
      method: 'POST',
      headers: { authorization: 'Bearer fake', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const [one, two] = await Promise.all([handle(req(q)), handle(req(q))]);
  expect(one.status).toBe(200);
  expect(two.status).toBe(200);
  expect(approve).toHaveBeenCalledTimes(1);
  expect((await handle(req({ ...q, payload: { message: 'changed' } }))).status).toBe(409);
  expect((await handle(new Request('https://mock/v1/capabilities'))).status).toBe(401);
});

it('verifies remote NEAR signed bytes and binds receiver, args, gas and the one-yocto deposit', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { base58, base64 } = await import('@scure/base');
  const { actions, createTransaction, PublicKey, Signature, SignedTransaction } = await import(
    'near-api-js'
  );
  const seed = new Uint8Array(32).fill(9);
  const key = `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`;
  const payload = {
    receiverId: 'usdc.near',
    method: 'ft_transfer_call',
    args: { receiver_id: 'annon.near', amount: '1', msg: 'exact' },
    gas: '150000000000000',
    deposit: '1',
  };
  const tx = createTransaction(
    'bot.near',
    PublicKey.fromString(key),
    payload.receiverId,
    1n,
    [actions.functionCall(payload.method, payload.args, BigInt(payload.gas), 1n)],
    new Uint8Array(32).fill(1),
  );
  const result = {
    signedTransaction: base64.encode(
      new SignedTransaction({
        transaction: tx,
        signature: new Signature({ keyType: 0, data: ed25519.sign(sha256(tx.encode()), seed) }),
      }).encode(),
    ),
  };
  const q = signingRequest('near.signTransaction', 'near:mainnet', 'bot.near', {
    ...payload,
    transaction: base64.encode(tx.encode()),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ id: body.id, result: { permission: 'FullAccess' } });
    }),
  );
  try {
    await verifySigningResult(q, result, 'https://rpc');
    for (const edit of [
      { deposit: '0' },
      { gas: '1' },
      { receiverId: 'other.near' },
      { args: {} },
    ]) {
      await expect(
        verifySigningResult(
          { ...q, payload: { ...(q.payload as object), ...edit } },
          result,
          'https://rpc',
        ),
      ).rejects.toThrow();
    }
    await expect(
      verifySigningResult({ ...q, expiresAt: 0 }, result, 'https://rpc'),
    ).rejects.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('polls reference pending approval idempotently, and rejects wrong IDs and terminal rejection', async () => {
  const { signerMock } = await import('./signer-mock.js');
  const q = signingRequest('evm.personalSign', 'eip155:8453', identity.id, { message: 'approve' });
  const result = { signature: await a.signMessage({ message: 'approve' }) };
  const handle = signerMock({
    credential: 'fake',
    account: q.account,
    chain: q.chain,
    operations: [q.operation],
    approve: async () => 'pending',
  });
  const fetcher: typeof fetch = async (url, init) => handle(new Request(String(url), init));
  const sign = remoteSigner({
    url: 'https://mock',
    credential: async () => 'fake',
    fetch: fetcher,
    wait: async () => handle.decide(q.id, result),
  });
  await expect(sign(q, (r) => verifySigningResult(q, r, ''))).resolves.toEqual(result);
  expect(() => handle.decide(q.id, 'rejected')).toThrow();
  for (const status of ['wrong-id', 'rejected']) {
    const fetcher: typeof fetch = async (url) =>
      String(url).endsWith('capabilities')
        ? Response.json({
            version: 1,
            account: q.account,
            chain: q.chain,
            operations: [q.operation],
          })
        : Response.json({
            version: 1,
            id: status === 'wrong-id' ? 'other' : q.id,
            status: status === 'wrong-id' ? 'approved' : 'rejected',
            result,
          });
    await expect(
      remoteSigner({ url: 'https://mock', credential: async () => 'fake', fetch: fetcher })(
        q,
        async () => {},
      ),
    ).rejects.toThrow();
  }
});

it('retries a lost create response with identical id and payload, signing once', async () => {
  const { signerMock } = await import('./signer-mock.js');
  const q = signingRequest('evm.personalSign', 'eip155:8453', identity.id, { message: 'retry' });
  const approve = vi.fn(async () => ({ signature: await a.signMessage({ message: 'retry' }) }));
  const handle = signerMock({
    credential: 'fake',
    account: q.account,
    chain: q.chain,
    operations: [q.operation],
    approve,
  });
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const response = await handle(new Request(String(url), init));
    if (init?.method === 'POST') {
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new TypeError('response lost');
    }
    return response;
  };
  await remoteSigner({
    url: 'https://mock',
    credential: async () => 'fake',
    fetch: fetcher,
    wait: async () => {},
  })(q, (r) => verifySigningResult(q, r, ''));
  expect(bodies).toEqual([JSON.stringify(q), JSON.stringify(q)]);
  expect(approve).toHaveBeenCalledTimes(1);
});

it('returns the known transaction hash when finalized verification is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  try {
    const q = signingRequest('near.signTransaction', 'near:testnet', 'bot.near', {
      receiverId: 'token.near',
      method: 'ft_transfer_call',
      args: {},
      gas: '150000000000000',
      deposit: '1',
    });
    await expect(
      verifySigningResult(q, { txHash: 'KNOWN-HASH' }, 'https://fake.rpc'),
    ).rejects.toMatchObject({ code: 'transaction_uncertain', txHash: 'KNOWN-HASH' });
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['receiver', 'method', 'args', 'gas', 'deposit', 'failed', 'signer', 'hash', 'actions'])(
  'rejects definite finalized %s mismatches without uncertain evidence',
  async (mismatch) => {
    const q = signingRequest('near.signTransaction', 'near:testnet', 'bot.near', {
      receiverId: 'token.near',
      method: 'ft_transfer_call',
      args: { amount: '1' },
      gas: '150000000000000',
      deposit: '1',
    });
    const fc = {
      method_name: 'ft_transfer_call',
      args: Buffer.from(JSON.stringify({ amount: '1' })).toString('base64'),
      gas: '150000000000000',
      deposit: '1',
    };
    const transaction = {
      hash: 'HASH',
      signer_id: 'bot.near',
      receiver_id: 'token.near',
      actions: [{ FunctionCall: fc }],
    };
    if (mismatch === 'receiver') transaction.receiver_id = 'evil.near';
    if (mismatch === 'signer') transaction.signer_id = 'evil.near';
    if (mismatch === 'hash') transaction.hash = 'OTHER';
    if (mismatch === 'method') fc.method_name = 'other';
    if (mismatch === 'args') fc.args = Buffer.from('{}').toString('base64');
    if (mismatch === 'gas') fc.gas = '1';
    if (mismatch === 'deposit') fc.deposit = '0';
    if (mismatch === 'actions') transaction.actions.push({ FunctionCall: fc });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        Response.json({
          id: JSON.parse(String(init?.body)).id,
          result: {
            final_execution_status: 'FINAL',
            transaction,
            status: mismatch === 'failed' ? { Failure: 'rejected' } : { SuccessValue: '' },
            receipts_outcome: [],
          },
        }),
      ),
    );
    try {
      const error = await verifySigningResult(q, { txHash: 'HASH' }, 'https://fake.rpc').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('code', 'transaction_uncertain');
      expect(error).not.toHaveProperty('txHash');
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it('retains uncertainty for a non-final transaction status', async () => {
  const q = signingRequest('near.signTransaction', 'near:testnet', 'bot.near', {
    receiverId: 'token.near',
    method: 'call',
    args: {},
    gas: '1',
    deposit: '0',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json({
        id: JSON.parse(String(init?.body)).id,
        result: { final_execution_status: 'INCLUDED' },
      }),
    ),
  );
  try {
    await expect(
      verifySigningResult(q, { txHash: 'HASH' }, 'https://fake.rpc'),
    ).rejects.toMatchObject({ code: 'transaction_uncertain', txHash: 'HASH' });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('rejects a definite RPC refusal instead of saving hash evidence', async () => {
  const q = signingRequest('near.signTransaction', 'near:testnet', 'bot.near', {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json({
        id: JSON.parse(String(init?.body)).id,
        error: { cause: { name: 'INVALID_TRANSACTION', info: 'invalid signature' } },
      }),
    ),
  );
  try {
    const error = await verifySigningResult(q, { txHash: 'FORGED' }, 'https://fake.rpc').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code', 'transaction_uncertain');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('accepts an exact successful final txHash result from one RPC snapshot', async () => {
  const q = signingRequest('near.signTransaction', 'near:testnet', 'bot.near', {
    receiverId: 'token.near',
    method: 'ft_transfer_call',
    args: { amount: '1' },
    gas: '150000000000000',
    deposit: '1',
  });
  const fetcher = vi.fn(async (_url, init) =>
    Response.json({
      id: JSON.parse(String(init?.body)).id,
      result: {
        final_execution_status: 'FINAL',
        transaction: {
          hash: 'HASH',
          signer_id: 'bot.near',
          receiver_id: 'token.near',
          actions: [
            {
              FunctionCall: {
                method_name: 'ft_transfer_call',
                args: Buffer.from(JSON.stringify({ amount: '1' })).toString('base64'),
                gas: 150000000000000,
                deposit: '1',
              },
            },
          ],
        },
        status: { SuccessValue: '' },
        receipts_outcome: [],
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    await expect(
      verifySigningResult(q, { txHash: 'HASH' }, 'https://fake.rpc'),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
