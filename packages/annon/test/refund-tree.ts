/** Append-only, zero-padded, depth-32 refund tree, spec §8. */
import { sha256 } from '@noble/hashes/sha2.js';
import { account, bytes, concat, hash, hex, le, network, str } from '../src/settle-near/codec.js';
import { encodeIdentity, type Identity } from '../src/settle-near/identity.js';

export interface RefundLeaf {
  network: string;
  contract: string;
  delivery_id: string;
  refund: Identity;
  amount: string;
}
export function encodeRefundLeaf(f: RefundLeaf): Uint8Array<ArrayBuffer> {
  return concat(
    str(network(f.network)),
    str(account(f.contract)),
    le(f.delivery_id, 8),
    encodeIdentity(f.refund),
    le(f.amount, 16),
  );
}
export const refundLeaf = (f: RefundLeaf): string =>
  hash('annon/refund-leaf/v1', encodeRefundLeaf(f));
const refundNode = (left: string, right: string): string =>
  hex(sha256(concat(le(1, 1), bytes(left, 32), bytes(right, 32))));
const zeros = [hex(new Uint8Array(32))];
for (let h = 0; h < 32; h++) zeros.push(refundNode(zeros[h] as string, zeros[h] as string));
const capacity = 2 ** 32;

export class RefundTree {
  private size = 0;
  private readonly branches: (string | null)[] = Array.from({ length: 32 }, () => null);
  private fullRoot: string | undefined;
  get count(): number {
    return this.size;
  }
  /** Consumed frontier slots are null. Returned state is a copy. */
  get frontier(): readonly (string | null)[] {
    return [...this.branches];
  }
  get root(): string {
    if (this.fullRoot) return this.fullRoot;
    let node = zeros[0] as string;
    let count = this.size;
    for (let h = 0; h < 32; h++) {
      node =
        count % 2 === 1
          ? refundNode(this.branches[h] as string, node)
          : refundNode(node, zeros[h] as string);
      count = Math.floor(count / 2);
    }
    return node;
  }
  append(leaf: string): number {
    bytes(leaf, 32);
    if (this.size >= capacity) throw new RangeError('refund tree is full');
    const index = this.size;
    let count = index;
    let node = leaf;
    let h = 0;
    while (count % 2 === 1) {
      node = refundNode(this.branches[h] as string, node);
      this.branches[h] = null;
      count = Math.floor(count / 2);
      h++;
    }
    if (h === 32) this.fullRoot = node;
    else this.branches[h] = node;
    this.size++;
    return index;
  }
  /** Build from emitted leaves; the frontier itself intentionally retains no history. */
  static proof(leaves: readonly string[], index: number): string[] {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= leaves.length ||
      leaves.length > capacity
    )
      throw new RangeError('invalid leaf index');
    for (const leaf of leaves) bytes(leaf, 32);
    const proof: string[] = [];
    let layer = [...leaves];
    let at = index;
    for (let h = 0; h < 32; h++) {
      proof.push(layer[at % 2 === 0 ? at + 1 : at - 1] ?? (zeros[h] as string));
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2)
        next.push(refundNode(layer[i] as string, layer[i + 1] ?? (zeros[h] as string)));
      layer = next;
      at = Math.floor(at / 2);
    }
    return proof;
  }
}
export function verifyRefundProof(
  leaf: string,
  index: number,
  proof: readonly string[],
  root: string,
): boolean {
  try {
    bytes(leaf, 32);
    bytes(root, 32);
    if (!Number.isSafeInteger(index) || index < 0 || index >= capacity || proof.length !== 32)
      return false;
    let node = leaf;
    let at = index;
    for (const sibling of proof) {
      node = at % 2 === 0 ? refundNode(node, sibling) : refundNode(sibling, node);
      at = Math.floor(at / 2);
    }
    return node === root;
  } catch {
    return false;
  }
}
