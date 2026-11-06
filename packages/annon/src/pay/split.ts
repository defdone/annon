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
  /** Reward to whoever calls `distribute`, in millionths (at most 65 535, 6.5%). */
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
  /** The reward to whoever calls `distribute`, in percent. */
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

/**
 * Checks that `address` on Base is the ownerless 0xSplits V2.2 split `split`, created as `origin`
 * says, and returns what it pays whom. Throws `PayError` `bad_requirements` otherwise.
 */
export async function readSplit(
  baseRpc: string,
  address: string,
  split: Split,
  origin: SplitOrigin,
): Promise<SplitTerms> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TypeError('address must be 0x and 20 bytes');
  if (split.totalAllocation < 1n) fail('bad_requirements', 'the split allocates nothing');
  // `distribute` computes amount * allocation in uint256: with a larger total any real amount
  // overflows and the money stays in the split.
  if (split.totalAllocation >= 2n ** 128n) {
    fail('bad_requirements', 'the split allocations are too large to distribute');
  }
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
