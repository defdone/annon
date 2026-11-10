//! The refund accumulator (specs/near-settlement.md §8): an append-only depth-32 Merkle tree whose
//! fixed-size frontier is written for a delivery that can't get storage of its own. Anyone later
//! proves a leaf and turns it into an ordinary refund, paying that storage.
use near_sdk::{env, near, AccountId};

use crate::identity::Identity;
use crate::terms::tagged_hash;

pub const DEPTH: usize = 32;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Leaf {
    pub network: String,
    pub contract: AccountId,
    pub delivery_id: u64,
    pub refund: Identity,
    pub amount: u128,
}

impl Leaf {
    pub fn hash(&self) -> [u8; 32] {
        tagged_hash("annon/refund-leaf/v1", self)
    }
}

fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    let mut b = [0u8; 65];
    b[0] = 1;
    b[1..33].copy_from_slice(l);
    b[33..].copy_from_slice(r);
    env::sha256_array(b)
}

/// Roots of empty subtrees: `zero[0] = [0; 32]`, `zero[h+1] = node(zero[h], zero[h])`.
fn zeros() -> [[u8; 32]; DEPTH + 1] {
    let mut z = [[0u8; 32]; DEPTH + 1];
    for h in 0..DEPTH {
        z[h + 1] = node(&z[h], &z[h]);
    }
    z
}

#[near(serializers = [borsh])]
pub struct Accumulator {
    /// The left sibling at each height on the path of the next leaf.
    frontier: [[u8; 32]; DEPTH],
    pub count: u64,
    pub root: [u8; 32],
}

impl Accumulator {
    pub fn new() -> Self {
        Self {
            frontier: [[0; 32]; DEPTH],
            count: 0,
            root: zeros()[DEPTH],
        }
    }

    /// Appends a leaf; returns its index. Writes only fixed-size fields.
    pub fn push(&mut self, leaf: [u8; 32]) -> u64 {
        let z = zeros();
        let index = self.count;
        let (mut cur, mut i) = (leaf, index);
        for (h, zero) in z.iter().take(DEPTH).enumerate() {
            if i & 1 == 0 {
                self.frontier[h] = cur;
                cur = node(&cur, zero);
            } else {
                cur = node(&self.frontier[h], &cur);
            }
            i >>= 1;
        }
        self.root = cur;
        self.count += 1;
        index
    }
}

/// Whether `leaf` is at `index` under `root`, given its sibling path from the bottom.
pub fn verify(root: &[u8; 32], leaf: [u8; 32], index: u64, proof: &[[u8; 32]]) -> bool {
    if proof.len() != DEPTH || index >= 1 << DEPTH {
        return false;
    }
    let mut cur = leaf;
    for (h, sib) in proof.iter().enumerate() {
        cur = if (index >> h) & 1 == 0 {
            node(&cur, sib)
        } else {
            node(sib, &cur)
        };
    }
    &cur == root
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The proof of `index` among `leaves`, built from the whole tree (an independent path to the root).
    pub fn proof(leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
        let z = zeros();
        let mut level: Vec<[u8; 32]> = leaves.to_vec();
        let mut i = index;
        let mut out = vec![];
        for zero in z.iter().take(DEPTH) {
            let sib = level.get(i ^ 1).copied().unwrap_or(*zero);
            out.push(sib);
            level = level
                .chunks(2)
                .map(|c| node(&c[0], c.get(1).unwrap_or(zero)))
                .collect();
            i >>= 1;
        }
        out
    }

    fn root_of(leaves: &[[u8; 32]]) -> [u8; 32] {
        let z = zeros();
        let mut level = leaves.to_vec();
        for zero in z.iter().take(DEPTH) {
            if level.is_empty() {
                return z[DEPTH];
            }
            level = level
                .chunks(2)
                .map(|c| node(&c[0], c.get(1).unwrap_or(zero)))
                .collect();
        }
        level[0]
    }

    #[test]
    fn the_frontier_root_equals_the_full_tree_root_and_proofs_verify() {
        let mut acc = Accumulator::new();
        assert_eq!(acc.root, root_of(&[]));
        let leaves: Vec<[u8; 32]> = (0..9u8).map(|i| env::sha256_array([i])).collect();
        for (n, l) in leaves.iter().enumerate() {
            assert_eq!(acc.push(*l), n as u64);
            assert_eq!(acc.root, root_of(&leaves[..=n]), "after {n}");
            for j in 0..=n {
                assert!(verify(
                    &acc.root,
                    leaves[j],
                    j as u64,
                    &proof(&leaves[..=n], j)
                ));
            }
        }
    }

    #[test]
    fn a_wrong_leaf_index_or_path_fails() {
        let mut acc = Accumulator::new();
        let leaves: Vec<[u8; 32]> = (0..5u8).map(|i| env::sha256_array([i])).collect();
        for l in &leaves {
            acc.push(*l);
        }
        let p = proof(&leaves, 3);
        assert!(verify(&acc.root, leaves[3], 3, &p));
        assert!(!verify(&acc.root, leaves[2], 3, &p));
        assert!(!verify(&acc.root, leaves[3], 2, &p));
        let mut q = p.clone();
        q[5][0] ^= 1;
        assert!(!verify(&acc.root, leaves[3], 3, &q));
        assert!(!verify(&acc.root, leaves[3], 3, &p[..DEPTH - 1]));
        assert!(!verify(&acc.root, leaves[3], 3 + (1 << DEPTH), &p));
    }
}
