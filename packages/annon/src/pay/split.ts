/**
 * Revenue splits through the address (`specs/x402-annon.md`, section 8): when a file's `pay_to` is
 * an 0xSplits v2 split, the integrator shows the seller where the money goes before they sign. The
 * split keeps only `keccak256(abi.encode(split))` on chain, so the caller supplies the split and how
 * it was created (both from its `SplitCreated` event, or its own config).
 *
 * The address alone proves the rest: an 0xSplits V2.2 factory deploys each split with CREATE2 from
 * a salt that commits to the split and its owner, and initializes it in the same transaction. If the
 * address recomputed for `owner = 0` is `pay_to` and its code is the factory's clone, the canonical
 * factory made it with these terms and nobody ever controlled it (no left-over USDC approvals from a
 * former owner). Code that merely answers `splitHash()` and `owner()` correctly does not pass.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { fail, getCode, head, PayError, viewWord } from './base.js';
import { addressWord, fromHex, toHex, word } from './eip3009.js';

/** An 0xSplits v2 split, as `SplitV2Lib.Split`. */
export interface Split {
  recipients: string[];
  /** Shares, in any unit below 2^128 in total; each recipient gets `amount * allocation / total`. */
  allocations: bigint[];
  totalAllocation: bigint;
  /** Reward to the distributor the `distribute` caller names, in millionths (at most 65 535, 6.5535%). */
  distributionIncentive: number;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** `abi.encode(split)`: the struct as one dynamic tuple (offset, then head, then the two arrays). */
export function encodeSplit(s: Split): Uint8Array {
  const n = s.recipients.length;
  if (s.allocations.length !== n) throw new TypeError('one allocation per recipient');
  if (
    !Number.isInteger(s.distributionIncentive) ||
    s.distributionIncentive < 0 ||
    s.distributionIncentive > 0xffff
  ) {
    throw new RangeError('distributionIncentive is a uint16');
  }
  const recipients = concat([word(BigInt(n)), ...s.recipients.map(addressWord)]);
  const allocations = concat([word(BigInt(n)), ...s.allocations.map(word)]);
  const head = concat([
    word(4n * 32n),
    word(4n * 32n + BigInt(recipients.length)),
    word(s.totalAllocation),
    word(BigInt(s.distributionIncentive)),
  ]);
  return concat([word(32n), head, recipients, allocations]);
}

export const splitHash = (s: Split) => toHex(keccak_256(encodeSplit(s)));

export interface SplitTerms {
  /** `push`: `distribute` pays the wallets; `pull`: it credits them in the SplitsWarehouse. */
  kind: 'push' | 'pull';
  /** Each recipient and its share of a payment, after the distribution reward, in percent. */
  shares: { recipient: string; percent: number }[];
  /** The reward to the distributor the `distribute` caller names, in percent. */
  distributorPercent: number;
}

/** How the factory named the split: `createSplitDeterministic`'s salt or `createSplit`'s nonce. */
export type SplitOrigin = { salt: string } | { nonce: bigint };

/**
 * The 0xSplits V2.2 factories on Base (`deployments/8453.json` at 0159376) and the implementation
 * each clones (`SPLIT_WALLET_IMPLEMENTATION()`, read 6 Nov 2026). Push pays recipients' wallets at
 * `distribute`; pull credits them in the SplitsWarehouse, from which they withdraw.
 * ponytail: V2.2 only; older factories after their clones are checked on chain.
 */
export const SPLIT_FACTORIES = [
  {
    kind: 'push',
    factory: '0x8e8eb0cc6ae34a38b67d5cf91aca38f60bc3ecf4',
    implementation: '0x1e2086a7e84a32482ac03000d56925f607ccb708',
  },
  {
    kind: 'pull',
    factory: '0x6b9118074ab15142d7524e8c4ea8f62a3bdb98f1',
    implementation: '0x98254aedb6b2c30b70483064367f0ba24ca86244',
  },
] as const;

/** The 89-byte runtime of `Clone.sol` (a minimal proxy with an ETH `receive`) for `implementation`. */
export const cloneCode = (implementation: string) =>
  `0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d73${implementation.slice(2).toLowerCase()}5af43d3d93803e605757fd5bf3`;

/** Where `factory` deploys `split` for `owner` (`SplitFactoryV2._getSalt`, `Clone.initCodeHash`). */
export function splitAddress(
  f: { factory: string; implementation: string },
  split: Split,
  owner: string,
  origin: SplitOrigin,
): string {
  // abi.encode(split, owner): the tuple's offset, the owner, then the tuple.
  const params = concat([word(64n), addressWord(owner), encodeSplit(split).subarray(32)]);
  let salt: Uint8Array;
  if ('salt' in origin) {
    salt = keccak_256(concat([params, fromHex(origin.salt, 32, 'salt')]));
  } else {
    salt = keccak_256(concat([keccak_256(params), word(origin.nonce)]));
  }
  // CREATE (9 bytes) + runtime (89) + 15 zero bytes: Clone.sol hashes 0x71 bytes from 0x0f.
  const init = concat([
    fromHex('0x60593d8160093d39f3', 9, 'init'),
    fromHex(cloneCode(f.implementation), 89, 'clone'),
    new Uint8Array(15),
  ]);
  const h = keccak_256(
    concat([Uint8Array.of(0xff), fromHex(f.factory, 20, 'factory'), salt, keccak_256(init)]),
  );
  return toHex(h.subarray(12));
}

const ZERO = `0x${'00'.repeat(20)}`;
const selector = (sig: string) => toHex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4));
const calldata = (sig: string, ...parts: Uint8Array[]) =>
  selector(sig) + toHex(concat(parts)).slice(2);
const SPLIT_TUPLE = '(address[],uint256[],uint256,uint16)';
/** The split's tuple without the leading offset word, for a call that has other arguments. */
const tuple = (s: Split) => encodeSplit(s).subarray(32);

/** The SplitsWarehouse on Base, where a pull split credits its recipients. */
export const SPLITS_WAREHOUSE = '0x8fb66f38cf86a3d5e8768f8f1754a24a6c661fb8';

/**
 * Most recipients a split may have here. A push `distribute` makes one USDC transfer (about 30k to
 * 60k gas) per recipient in one transaction; 100 stays far below Base's gas limits.
 */
export const MAX_RECIPIENTS = 100;

/** Terms the SDK accepts, whether it creates the split or reads one. */
function checkTerms(s: Split) {
  if (s.recipients.length > MAX_RECIPIENTS) {
    fail('bad_requirements', `the split has more than ${MAX_RECIPIENTS} recipients`);
  }
  // USDC refuses any transfer to address 0: a push split could never pay anyone, a pull split
  // would keep that share for good.
  if (s.recipients.some((r) => BigInt(r) === 0n)) {
    fail('bad_requirements', 'the split pays the zero address');
  }
  if (s.totalAllocation < 1n) fail('bad_requirements', 'the split allocates nothing');
  // `distribute` computes amount * allocation / total in uint256. With the total below 2^128 that
  // cannot overflow for any amount below 2^128 (USDC's supply is far smaller); above, a large
  // enough payment would, and the money would stay in the split.
  if (s.totalAllocation >= 2n ** 128n) {
    fail('bad_requirements', 'the split allocations are too large to distribute');
  }
}

/** A transaction to send from any wallet on Base. */
export interface SplitCall {
  to: string;
  data: string;
}

/**
 * The transaction that creates `split` as an ownerless (immutable) split of `kind` at the address
 * it returns. Send it from any wallet on Base. Keep `split` and `salt`: `readSplit` needs them, and
 * the same terms and salt always give the same address (sent again, the factory just returns it).
 */
export function createSplit(
  kind: 'push' | 'pull',
  split: Split,
  salt: string,
): SplitCall & { address: string } {
  checkTerms(split);
  if (split.allocations.reduce((a, b) => a + b, 0n) !== split.totalAllocation) {
    throw new RangeError('the allocations must add up to totalAllocation');
  }
  const f = SPLIT_FACTORIES.find((f) => f.kind === kind);
  if (!f) throw new TypeError('kind is push or pull');
  const data = calldata(
    `createSplitDeterministic(${SPLIT_TUPLE},address,address,bytes32)`,
    word(128n),
    addressWord(ZERO),
    addressWord(ZERO),
    fromHex(salt, 32, 'salt'),
    tuple(split),
  );
  return { to: f.factory, data, address: splitAddress(f, split, ZERO, { salt }) };
}

/**
 * The calls that pay out what the split at `address` holds in `token`: `distribute` first, then
 * for a pull split one SplitsWarehouse withdrawal per recipient (and for `distributor`, if the
 * split pays a reward), each paying that address's wallet. Anyone may send them; the sender pays
 * the gas and `distributor` gets the split's distribution reward. `payoutCall` sends them as one
 * transaction. Sent one by one, each goes after the one before it is in a block: a wallet
 * estimates a withdrawal on the current state, and before `distribute` lands there is nothing to
 * withdraw.
 */
/** Multicall3, at the same address on Base as on every chain it is deployed to. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * The payout as one transaction through Multicall3 `aggregate3`. `distribute` must succeed or the
 * whole transaction reverts; each withdrawal may fail on its own (nothing to pay, a USDC-blacklisted
 * or paused recipient) without stopping the others. A push split's payout is already one call.
 * Check the receipt's warehouse events for who was paid: a transaction that succeeded may still
 * hold a failed withdrawal.
 */
export function payoutCall(
  kind: 'push' | 'pull',
  address: string,
  split: Split,
  token: string,
  distributor: string,
): SplitCall {
  const calls = payoutCalls(kind, address, split, token, distributor);
  if (kind === 'push') return calls[0] as SplitCall;
  // aggregate3((address target, bool allowFailure, bytes callData)[]): the array's offset, its
  // length, one offset per element (from after the length), then each element.
  const elements = calls.map((c, i) => {
    const data = fromHex(c.data, (c.data.length - 2) / 2, 'callData');
    const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
    padded.set(data);
    return concat([
      addressWord(c.to),
      word(i === 0 ? 0n : 1n),
      word(96n),
      word(BigInt(data.length)),
      padded,
    ]);
  });
  const offsets: Uint8Array[] = [];
  let at = 32n * BigInt(elements.length);
  for (const e of elements) {
    offsets.push(word(at));
    at += BigInt(e.length);
  }
  return {
    to: MULTICALL3,
    data: calldata(
      `aggregate3((address,bool,bytes)[])`,
      word(32n),
      word(BigInt(elements.length)),
      ...offsets,
      ...elements,
    ),
  };
}

export function payoutCalls(
  kind: 'push' | 'pull',
  address: string,
  split: Split,
  token: string,
  distributor: string,
): SplitCall[] {
  // A pull split would credit the reward to address 0 for good; push could never distribute.
  if (BigInt(distributor) === 0n) throw new TypeError('distributor is the address that sends them');
  const calls = [
    {
      to: address.toLowerCase(),
      data: calldata(
        `distribute(${SPLIT_TUPLE},address,address)`,
        word(96n),
        addressWord(token),
        addressWord(distributor),
        tuple(split),
      ),
    },
  ];
  if (kind === 'pull') {
    const paid = [...split.recipients, ...(split.distributionIncentive > 0 ? [distributor] : [])];
    for (const r of new Set(paid.map((r) => r.toLowerCase()))) {
      calls.push({
        to: SPLITS_WAREHOUSE,
        data: calldata('withdraw(address,address)', addressWord(r), addressWord(token)),
      });
    }
  }
  return calls;
}

/**
 * Checks that `address` on Base is the ownerless 0xSplits V2.2 split `split`, created as `origin`
 * says, and returns what it pays whom. Throws `PayError` `bad_requirements` otherwise.
 * It proves the terms, not that a payout will go through: Circle can blacklist a recipient (a push
 * split then pays nobody, a pull split only not that one) or the split itself, and shares round down.
 */
export async function readSplit(
  baseRpc: string,
  address: string,
  split: Split,
  origin: SplitOrigin,
): Promise<SplitTerms> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TypeError('address must be 0x and 20 bytes');
  checkTerms(split);
  const to = address.toLowerCase();
  const f = SPLIT_FACTORIES.find((f) => splitAddress(f, split, ZERO, origin) === to);
  if (!f) {
    return fail(
      'bad_requirements',
      `${address} is not an ownerless 0xSplits V2.2 split of these terms`,
    );
  }
  const at = (await head(baseRpc)).number;
  if ((await getCode(baseRpc, to, at)) !== cloneCode(f.implementation)) {
    fail('bad_requirements', `${address} is not deployed yet`);
  }
  const read = (sig: string) =>
    viewWord(baseRpc, address, selector(sig), at).catch((e: unknown) => {
      // A contract without the function reverts, a wallet answers nothing: neither is a split.
      if (e instanceof PayError && /revert|eth_call result/i.test(e.message)) {
        fail('bad_requirements', `${address} does not answer ${sig}: not an 0xSplits v2 split`);
      }
      throw e;
    });
  if ((await read('splitHash()')) !== splitHash(split)) {
    fail('bad_requirements', 'the split on chain is not the one described');
  }
  if (BigInt(await read('owner()')) !== 0n) {
    fail('bad_requirements', 'the split has an owner who could change where the money goes');
  }
  if (BigInt(await read('paused()')) !== 0n) fail('bad_requirements', 'the split is paused');
  const pct = (part: bigint, whole: bigint) => Number((part * 1_000_000n) / whole) / 10_000;
  const kept = 1_000_000 - split.distributionIncentive;
  return {
    kind: f.kind,
    shares: split.recipients.map((r, i) => ({
      recipient: r.toLowerCase(),
      percent: (pct(split.allocations[i] ?? 0n, split.totalAllocation) * kept) / 1_000_000,
    })),
    distributorPercent: split.distributionIncentive / 10_000,
  };
}
