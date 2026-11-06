import {
  concat,
  encodeAbiParameters,
  encodeFunctionResult,
  getContractAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayError } from './base.js';
import {
  cloneCode,
  encodeSplit,
  readSplit,
  SPLIT_FACTORIES,
  type Split,
  type SplitOrigin,
  splitAddress,
  splitHash,
} from './split.js';

// viem's ABI encoder is the oracle for Solidity's abi.encode(SplitV2Lib.Split).
const SPLIT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'recipients', type: 'address[]' },
      { name: 'allocations', type: 'uint256[]' },
      { name: 'totalAllocation', type: 'uint256' },
      { name: 'distributionIncentive', type: 'uint16' },
    ],
  },
] as const;
const viemEncode = (s: Split) =>
  encodeAbiParameters(SPLIT_TUPLE, [
    {
      recipients: s.recipients as `0x${string}`[],
      allocations: s.allocations,
      totalAllocation: s.totalAllocation,
      distributionIncentive: s.distributionIncentive,
    },
  ]);
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;

const SELLER = `0x${'ab'.repeat(20)}`;
const SAFE = `0x${'5a'.repeat(20)}`;
const partner: Split = {
  recipients: [SELLER, SAFE],
  allocations: [950_000n, 50_000n],
  totalAllocation: 1_000_000n,
  distributionIncentive: 0,
};

describe('encodeSplit against viem', () => {
  it('encodes abi.encode(split) byte for byte, for any shape', () => {
    const shapes: Split[] = [
      partner,
      { recipients: [], allocations: [], totalAllocation: 0n, distributionIncentive: 0 },
      {
        recipients: [SELLER],
        allocations: [1n],
        totalAllocation: 1n,
        distributionIncentive: 65_535,
      },
      {
        recipients: Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).repeat(40)}`),
        allocations: [1n, 2n, 3n, 4n, 5n, 6n, 2n ** 255n],
        totalAllocation: 2n ** 255n + 21n,
        distributionIncentive: 12_345,
      },
    ];
    for (const s of shapes) {
      expect(hex(encodeSplit(s))).toBe(viemEncode(s));
      expect(splitHash(s)).toBe(keccak256(viemEncode(s)));
    }
  });

  it('refuses a split it cannot encode', () => {
    expect(() => encodeSplit({ ...partner, allocations: [1n] })).toThrow(TypeError);
    expect(() => encodeSplit({ ...partner, distributionIncentive: 65_536 })).toThrow(RangeError);
  });
});

// The runtime code of real splits, as eth_getCode returned it on Base (7 Nov 2026) for a push and
// a pull split of the V2.2 factories. Independent of `cloneCode`, which must reproduce it.
const RUNTIME = {
  push: '0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d731e2086a7e84a32482ac03000d56925f607ccb7085af43d3d93803e605757fd5bf3',
  pull: '0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d7398254aedb6b2c30b70483064367f0ba24ca862445af43d3d93803e605757fd5bf3',
} as const;

// viem's CREATE2 and ABI encoder are the oracle for SplitFactoryV2's address derivation.
const viemAddress = (
  f: (typeof SPLIT_FACTORIES)[number],
  s: Split,
  owner: `0x${string}`,
  origin: { salt: `0x${string}` } | { nonce: bigint },
) => {
  const params = encodeAbiParameters(
    [...SPLIT_TUPLE, { type: 'address' }],
    [
      {
        recipients: s.recipients as `0x${string}`[],
        allocations: s.allocations,
        totalAllocation: s.totalAllocation,
        distributionIncentive: s.distributionIncentive,
      },
      owner,
    ],
  );
  const salt =
    'salt' in origin
      ? keccak256(concat([params, origin.salt]))
      : keccak256(
          concat([keccak256(params), encodeAbiParameters([{ type: 'uint256' }], [origin.nonce])]),
        );
  // Clone.sol: the 9-byte creation prefix, the runtime, and the 15 zero bytes it hashes too.
  const init = concat(['0x60593d8160093d39f3', RUNTIME[f.kind], `0x${'00'.repeat(15)}`]);
  return getContractAddress({
    opcode: 'CREATE2',
    from: f.factory,
    salt,
    bytecodeHash: keccak256(init),
  }).toLowerCase();
};

const ZERO = `0x${'00'.repeat(20)}` as const;
const SALT = { salt: `0x${'c4'.repeat(32)}` } as const;
const [PUSH, PULL] = SPLIT_FACTORIES;

describe('splitAddress against viem', () => {
  it('builds exactly the clone code real splits have on Base', () => {
    for (const f of SPLIT_FACTORIES) expect(cloneCode(f.implementation)).toBe(RUNTIME[f.kind]);
  });

  it('derives the factory CREATE2 address for salt and nonce, push and pull, any owner', () => {
    for (const f of SPLIT_FACTORIES)
      for (const origin of [SALT, { nonce: 0n }, { nonce: 7n }])
        for (const owner of [ZERO, SAFE as `0x${string}`]) {
          expect(splitAddress(f, partner, owner, origin)).toBe(
            viemAddress(f, partner, owner, origin),
          );
        }
  });

  it('gives another address for another owner, share, salt or factory', () => {
    const a = splitAddress(PUSH, partner, ZERO, SALT);
    expect(splitAddress(PUSH, partner, SAFE, SALT)).not.toBe(a);
    expect(
      splitAddress(PUSH, { ...partner, allocations: [949_999n, 50_001n] }, ZERO, SALT),
    ).not.toBe(a);
    expect(splitAddress(PUSH, partner, ZERO, { salt: `0x${'c5'.repeat(32)}` })).not.toBe(a);
    expect(splitAddress(PULL, partner, ZERO, SALT)).not.toBe(a);
  });
});

const ABI = parseAbi([
  'function splitHash() view returns (bytes32)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
]);
const SPLIT = splitAddress(PUSH, partner, ZERO, SALT);
let chain: {
  at: string;
  chainId: string;
  hash: string;
  owner: string;
  paused: boolean;
  code: string;
  calls: 'split' | 'revert';
};

beforeEach(() => {
  chain = {
    at: SPLIT,
    chainId: '0x2105',
    hash: splitHash(partner),
    owner: ZERO,
    paused: false,
    code: RUNTIME.push,
    calls: 'split',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      const reply = (result: unknown) => ({
        json: async () => ({ jsonrpc: '2.0', id: b.id, result }),
      });
      if (b.method === 'eth_chainId') return reply(chain.chainId);
      if (b.method === 'eth_getBlockByNumber') return reply({ number: '0x10', timestamp: '0x10' });
      if (b.method === 'eth_getCode')
        return reply(b.params[0].toLowerCase() === chain.at ? chain.code : '0x');
      const [{ to, data }] = b.params;
      if (b.method !== 'eth_call' || to.toLowerCase() !== chain.at)
        throw new Error(`unexpected ${b.method}`);
      if (chain.calls === 'revert') {
        return {
          json: async () => ({ id: b.id, error: { code: 3, message: 'execution reverted' } }),
        };
      }
      const fn = (['splitHash', 'owner', 'paused'] as const).find(
        (f) => toFunctionSelector(`${f}()`) === data,
      );
      if (fn === 'splitHash')
        return reply(
          encodeFunctionResult({ abi: ABI, functionName: fn, result: chain.hash as `0x${string}` }),
        );
      if (fn === 'owner')
        return reply(
          encodeFunctionResult({
            abi: ABI,
            functionName: fn,
            result: chain.owner as `0x${string}`,
          }),
        );
      if (fn === 'paused')
        return reply(encodeFunctionResult({ abi: ABI, functionName: fn, result: chain.paused }));
      throw new Error(`unexpected call ${data}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof PayError ? `${e.code}: ${e.message}` : String(e)),
  );

describe('readSplit', () => {
  it('returns who gets what from an ownerless V2.2 split', async () => {
    expect(await readSplit('https://base', SPLIT, partner, SALT)).toEqual({
      kind: 'push',
      shares: [
        { recipient: SELLER, percent: 95 },
        { recipient: SAFE, percent: 5 },
      ],
      distributorPercent: 0,
    });
  });

  it('knows a pull split by its factory', async () => {
    chain.at = splitAddress(PULL, partner, ZERO, SALT);
    chain.code = RUNTIME.pull;
    expect((await readSplit('https://base', chain.at, partner, SALT)).kind).toBe('pull');
  });

  it('takes the distributor reward off before the shares', async () => {
    const s = { ...partner, distributionIncentive: 10_000 }; // 1%
    chain.at = splitAddress(PUSH, s, ZERO, SALT);
    chain.hash = splitHash(s);
    const t = await readSplit('https://base', chain.at, s, SALT);
    expect(t.distributorPercent).toBe(1);
    expect(t.shares.map((x) => x.percent)).toEqual([94.05, 4.95]);
  });

  it('refuses terms the address does not commit to: other shares, an owner at creation, other salt', async () => {
    const cases: [Split, SplitOrigin][] = [
      [{ ...partner, allocations: [900_000n, 100_000n] }, SALT],
      [partner, { salt: `0x${'c5'.repeat(32)}` }],
      [partner, { nonce: 0n }],
    ];
    for (const [s, origin] of cases) {
      expect(await code(readSplit('https://base', SPLIT, s, origin))).toMatch(/not an ownerless/);
    }
    // Created with an owner (who could have approved USDC to anyone before renouncing).
    const owned = splitAddress(PUSH, partner, SAFE, SALT);
    expect(await code(readSplit('https://base', owned, partner, SALT))).toMatch(/not an ownerless/);
  });

  it('refuses code that is not the factory clone, even if it answers like a split', async () => {
    for (const c of [
      '0x',
      RUNTIME.pull,
      `${RUNTIME.push}00`,
      RUNTIME.push.replace('36602c57', '36602b57'),
    ]) {
      chain.code = c;
      expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(/not deployed/);
    }
  });

  it('refuses an RPC that is not Base', async () => {
    chain.chainId = '0x1';
    expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(/network_mismatch/);
  });

  it('refuses a split that allocates nothing or too much to distribute', async () => {
    for (const totalAllocation of [0n, 2n ** 128n]) {
      const s = { ...partner, allocations: [totalAllocation, 0n], totalAllocation };
      expect(await code(readSplit('https://base', SPLIT, s, SALT))).toMatch(
        /allocates nothing|too large/,
      );
    }
  });

  it('still checks the state on chain: hash, owner, pause, and a contract without the views', async () => {
    chain.hash = splitHash({ ...partner, allocations: [900_000n, 100_000n] });
    expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(
      /not the one described/,
    );
    chain.hash = splitHash(partner);
    chain.owner = SAFE;
    expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(/has an owner/);
    chain.owner = ZERO;
    chain.paused = true;
    expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(/paused/);
    chain.paused = false;
    chain.calls = 'revert';
    expect(await code(readSplit('https://base', SPLIT, partner, SALT))).toMatch(
      /not an 0xSplits v2 split/,
    );
  });
});
