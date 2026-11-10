// Independent wire oracle for specs/near-settlement.md. No SDK imports.
// node:crypto Borsh/hash/envelope implementation; hashes cross-checked with noble,
// EIP-191 signatures by viem; Ed25519 by node:crypto cross-checked with noble.
// All seeds/keys below are PUBLIC deterministic test fixtures, never use them for funds.
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 as nobleSha } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// viem is an existing SDK dev dependency; resolve it there, without adding runtime dependencies.
const require = createRequire(new URL('../../packages/annon/package.json', import.meta.url));
const { privateKeyToAccount } = await import(require.resolve('viem/accounts'));
const { hashMessage, keccak256 } = await import(require.resolve('viem'));
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const raw = (s) => Buffer.from(s.replace(/^0x/, ''), 'hex');
const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const sha = (...p) => {
  const b = cat(...p);
  const h = createHash('sha256').update(b).digest();
  assert.equal(hex(h), hex(nobleSha(b)));
  return h;
};
const le = (value, size) => {
  const b = Buffer.alloc(size);
  let n = BigInt(value);
  for (let i = 0; i < size; i++) {
    b[i] = Number(n % 256n);
    n /= 256n;
  }
  assert.equal(n, 0n);
  return b;
};
const be = (value, size) => Buffer.from(le(value, size)).reverse();
const str = (s) => cat(le(Buffer.byteLength(s), 4), s);
const tagged = (tag, b) => hex(sha(tag, [0], b));
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b) {
  let n = BigInt(hex(b));
  let s = '';
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const v of b) {
    if (v) break;
    s = `1${s}`;
  }
  return s;
}
const identity = (id) =>
  id.kind === 'evm'
    ? cat([0], raw(id.id))
    : id.kind === 'solana'
      ? cat([1], raw(id.id))
      : cat([2], str(id.id));
const textId = (id) =>
  id.kind === 'evm'
    ? `EVM ${id.id}`
    : id.kind === 'solana'
      ? `Solana ${base58(raw(id.id))}`
      : `NEAR ${id.id}`;
const money = (s) => {
  const n = BigInt(s);
  const fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n / 1000000n}${fraction ? `.${fraction}` : ''}`;
};
const utc = (n) => `${new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const usdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const contract = 'v2.annon.defdone.near';
const evmSeed = `0x${'01'.repeat(32)}`;
const evmWallet = privateKeyToAccount(evmSeed);
const edSeed = Buffer.alloc(32, 7);
const edKey = createPrivateKey({
  key: cat(raw('302e020100300506032b657004220420'), edSeed),
  format: 'der',
  type: 'pkcs8',
});
const edPublic = createPublicKey(edKey).export({ format: 'der', type: 'spki' }).subarray(-32);
assert.equal(hex(edPublic), hex(ed25519.getPublicKey(edSeed)));
const evm = { kind: 'evm', id: evmWallet.address.toLowerCase() };
const solana = { kind: 'solana', id: edPublic.toString('hex') };
const near = { kind: 'near', id: 'seller.near' };
const identities = [
  evm,
  { kind: 'evm', id: `0x${'00'.repeat(20)}` },
  solana,
  { kind: 'solana', id: '00'.repeat(32) },
  near,
  { kind: 'near', id: 'ab' },
  { kind: 'near', id: 'a'.repeat(64) },
  { kind: 'near', id: 'f'.repeat(64) },
].map((id) => ({
  identity: id,
  borsh: hex(identity(id)),
  json: JSON.stringify(id),
  text: textId(id),
  intents_account: id.id,
  ...(id.kind === 'solana' ? { base58: base58(raw(id.id)) } : {}),
}));
const fileId = hex(Buffer.alloc(32, 3));
const cipherHash = hex(Buffer.alloc(32, 4));
const buyerKey = hex(bls.G1.Point.BASE.toBytes(true));
const freshKey = hex(bls.G1.Point.BASE.multiply(2n).toBytes(true));
const deadline = 1794350000;
function encodeTerms(t) {
  return cat(
    str(t.network),
    str(t.contract),
    raw(t.file_id),
    identity(t.seller),
    [t.pay2_version],
    raw(t.cipher_hash),
    t.moderator === null ? [0] : cat([1], str(t.moderator)),
    str(t.near.token),
    le(t.near.price, 16),
    le(t.near.recipients.length, 4),
    ...t.near.recipients.map((r) => cat(identity(r.identity), le(r.bps, 2))),
    [t.near.remainder],
    t.base === null ? [0] : cat([1], raw(t.base.usdc), le(t.base.price, 16), raw(t.base.pay_to)),
  );
}
function registerText(t, hash) {
  return [
    'Annon: list a file for sale',
    'Signing this lets whoever holds the seller key below open the file.',
    `contract: ${t.contract}`,
    `file: ${t.file_id}`,
    `seller: ${textId(t.seller)}`,
    `price: ${money(t.near.price)} USDC on NEAR`,
    ...t.near.recipients.map(
      (r) =>
        `split: ${textId(r.identity)} ${Math.floor(r.bps / 100)}.${String(r.bps % 100).padStart(2, '0')}%`,
    ),
    `remainder: ${textId(t.near.recipients[t.near.remainder].identity)}`,
    t.base ? `base: ${money(t.base.price)} USDC on Base to ${t.base.pay_to}` : 'base: none',
    `cipher: ${t.cipher_hash}`,
    `moderator: ${t.moderator ?? '(none)'}`,
    `terms: ${hash}`,
    `seller key: ${buyerKey}`,
    `valid until: ${utc(deadline)}`,
  ].join('\n');
}
const allRecipients = identities
  .map((v) => v.identity)
  .sort((a, b) => Buffer.compare(identity(a), identity(b)))
  .map((id) => ({ identity: id, bps: 1250 }));
const terms = [
  {
    id: 'one-evm-base',
    seller: evm,
    recipients: [{ identity: evm, bps: 10000 }],
    base: { usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: '200000', pay_to: evm.id },
  },
  { id: 'eight-mixed-solana', seller: solana, recipients: allRecipients, base: null },
  {
    id: 'one-max-near',
    seller: identities[6].identity,
    recipients: [{ identity: near, bps: 10000 }],
    base: null,
  },
].map((v, i) => {
  const t = {
    network: 'near:mainnet',
    contract,
    file_id: fileId,
    seller: v.seller,
    pay2_version: 2,
    cipher_hash: cipherHash,
    moderator: i === 1 ? 'moderator.near' : null,
    near: {
      token: usdc,
      price: i === 2 ? '340282366920938463463374607431768211455' : '200000',
      recipients: v.recipients,
      remainder: v.recipients.length - 1,
    },
    base: v.base,
  };
  const b = encodeTerms(t);
  const hash = tagged('annon/terms/v2', b);
  return {
    id: v.id,
    terms: t,
    borsh: hex(b),
    terms_hash: hash,
    seller_key: buyerKey,
    deadline,
    register_text: registerText(t, hash),
  };
});
function encodePurchase(p) {
  return cat(
    [2],
    identity(p.refund),
    str(p.network),
    str(p.contract),
    [p.route === 'near-usdc' ? 0 : 1],
    str(p.asset),
    raw(p.file_id),
    raw(p.terms_hash),
    le(p.price, 16),
    raw(p.nonce),
    raw(p.buyer_key),
    identity(p.recovery),
    le(p.expires_at, 8),
  );
}
const purchases = [
  {
    id: 'near-evm-refund-solana-recovery',
    refund: evm,
    recovery: solana,
    route: 'near-usdc',
    network: 'near:mainnet',
    asset: usdc,
  },
  {
    id: 'near-solana-refund-evm-recovery',
    refund: solana,
    recovery: evm,
    route: 'near-usdc',
    network: 'near:mainnet',
    asset: usdc,
  },
  {
    id: 'near-max-accounts',
    refund: identities[6].identity,
    recovery: identities[7].identity,
    route: 'near-usdc',
    network: 'near:mainnet',
    asset: usdc,
  },
  {
    id: 'base-near-recovery',
    refund: solana,
    recovery: near,
    route: 'base-usdc',
    network: 'eip155:8453',
    asset: terms[0].terms.base.usdc,
  },
].map((v) => {
  const p = {
    version: 2,
    refund: v.refund,
    network: v.network,
    contract: v.id === 'near-max-accounts' ? 'c'.repeat(64) : contract,
    route: v.route,
    asset: v.asset,
    file_id: fileId,
    terms_hash: terms[0].terms_hash,
    price: '200000',
    nonce: hex(Buffer.alloc(32, 6)),
    buyer_key: buyerKey,
    recovery: v.recovery,
    expires_at: String(deadline),
  };
  const b = encodePurchase(p),
    id = tagged('annon/purchase/v2', b);
  const { version: _version, refund, ...body } = p;
  const message = JSON.stringify({ annon: 2, refund, purchase: { ...body, purchase_id: id } });
  assert.ok(Buffer.byteLength(message) <= 1024);
  const nonceInput = cat('annon/base-payment/v2', [0], raw(id));
  const baseNonce = hex(keccak_256(nonceInput));
  assert.equal(baseNonce, keccak256(hex(nonceInput)));
  const reopenText = [
    'Annon: open a purchased file again',
    `contract: ${p.contract}`,
    `purchase: ${id}`,
    `file: ${fileId}`,
    `recovery: ${textId(p.recovery)}`,
    `new key: ${freshKey}`,
    `nonce: ${p.nonce}`,
    `valid until: ${utc(deadline)}`,
  ].join('\n');
  return {
    id: v.id,
    purchase: p,
    borsh: hex(b),
    purchase_id: id,
    message,
    message_bytes: Buffer.byteLength(message),
    base_nonce_v2: baseNonce,
    reopen: {
      contract: p.contract,
      purchase_id: id,
      file_id: fileId,
      recovery: p.recovery,
      fresh_key: freshKey,
      nonce: p.nonce,
      deadline,
    },
    reopen_text: reopenText,
  };
});
const node = (left, right) => sha([1], left, right);
const zero = [Buffer.alloc(32)];
for (let i = 0; i < 32; i++) zero.push(node(zero[i], zero[i]));
const refunds = Array.from({ length: 5 }, (_, i) => {
  const f = {
    network: 'near:mainnet',
    contract,
    delivery_id: i === 4 ? '18446744073709551615' : String(i),
    refund: [evm, solana, near, identities[6].identity, evm][i],
    amount: i === 4 ? '340282366920938463463374607431768211455' : String(200000 + i),
  };
  const b = cat(
    str(f.network),
    str(f.contract),
    le(f.delivery_id, 8),
    identity(f.refund),
    le(f.amount, 16),
  );
  return { fields: f, borsh: hex(b), leaf: tagged('annon/refund-leaf/v1', b) };
});
// Sparse map oracle: derive each layer from leaves, independently of a frontier algorithm.
const merkle = [0, 1, 3, 5].map((count) => {
  const layers = [refunds.slice(0, count).map((v) => raw(v.leaf))];
  for (let h = 0; h < 32; h++) {
    const layer = layers[h];
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(node(layer[i], layer[i + 1] ?? zero[h]));
    layers.push(next);
  }
  const proofs = layers[0].map((_, index) => {
    let at = index;
    return {
      index,
      proof: layers.slice(0, 32).map((layer, h) => {
        const sibling = layer[at % 2 === 0 ? at + 1 : at - 1] ?? zero[h];
        at = Math.floor(at / 2);
        return hex(sibling);
      }),
    };
  });
  // Frontier is the rightmost complete subtree at each occupied count bit.
  const frontier = Array.from({ length: 32 }, (_, h) =>
    Math.floor(count / 2 ** h) % 2 ? hex(layers[h][Math.floor(count / 2 ** h) - 1]) : null,
  );
  return {
    count,
    leaves: refunds.slice(0, count).map((v) => v.leaf),
    frontier,
    root: hex(layers[32][0] ?? zero[32]),
    proofs,
  };
});
async function auth(text, id) {
  if (id.kind === 'near') return null;
  if (id.kind === 'evm') {
    const sig = await evmWallet.signMessage({ message: text });
    const digest = hex(
      keccak_256(cat(`\x19Ethereum Signed Message:\n${Buffer.byteLength(text)}`, text)),
    );
    assert.equal(digest, hashMessage(text));
    return { kind: 'evm', sig };
  }
  const sig = sign(null, Buffer.from(text), edKey);
  assert.ok(verify(null, Buffer.from(text), createPublicKey(edKey), sig));
  assert.ok(ed25519.verify(sig, Buffer.from(text), edPublic, { zip215: false }));
  return { kind: 'solana', sig: hex(sig) };
}
const authorizations = [];
for (const t of terms)
  authorizations.push({
    identity: t.terms.seller,
    text: t.register_text,
    auth: await auth(t.register_text, t.terms.seller),
    ...(t.terms.seller.kind === 'near' ? { predecessor: t.terms.seller.id } : {}),
  });
for (const p of purchases)
  authorizations.push({
    identity: p.purchase.recovery,
    text: p.reopen_text,
    auth: await auth(p.reopen_text, p.purchase.recovery),
    ...(p.purchase.recovery.kind === 'near' ? { predecessor: p.purchase.recovery.id } : {}),
  });
const hkdf = (k, s, i) => Buffer.from(hkdfSync('sha256', k, s, i, 32));
function gcm(key, last, plain) {
  const iv = Buffer.alloc(12);
  iv[11] = last ? 1 : 0;
  const c = createCipheriv('aes-256-gcm', key, iv);
  return cat(c.update(plain), c.final(), c.getAuthTag());
}
const pay2 = [];
for (const [kind, seller] of [evm, solana, near].entries()) {
  const K = Buffer.alloc(32, 2),
    ckd = bls.G1.Point.BASE.toBytes(true),
    fid = raw(fileId),
    data = Buffer.from('NEAR settlement vector — UTF-8\n'.repeat(5));
  const name = 'settlement.txt',
    mime = 'text/plain',
    previewLen = 10,
    chunkLog2 = 16;
  const fields = cat(be(Buffer.byteLength(name), 2), name, [mime.length], mime, be(data.length, 8));
  const pieces = [
    cat(fields, Buffer.alloc(256 - fields.length)),
    data.subarray(0, previewLen),
    data.subarray(previewLen),
  ];
  const keys = pieces.map((_, i) => hkdf(K, fid, cat('annon/pay2/chunk', be(i, 4))));
  const commits = keys.slice(0, 2).map((k) => sha('annon/pay2/key', k));
  const wire = pieces.map((p, i) => gcm(keys[i], i === 2, p));
  const hashes = wire.map((w) => sha(w));
  const wrap = hkdf(ckd, fid, 'annon/pay2/near-ckd/v1');
  const kw = createCipheriv('id-aes256-wrap', wrap, raw('a6a6a6a6a6a6a6a6'));
  const wrapped = cat(kw.update(K), kw.final());
  const stanzaBody = cat([contract.length], contract, wrapped);
  const stanza = cat([11], 'near-ckd/v1', be(stanzaBody.length, 2), stanzaBody);
  // 'near-ckd/v1' has length 11.
  const prefixLen = 54 + 32 * (2 + 3),
    headerLen = prefixLen + stanza.length + 97;
  const prefix = cat(
    'PAY2',
    [2, chunkLog2, 1, kind],
    be(headerLen, 4),
    fid,
    be(256, 2),
    be(previewLen, 4),
    be(3, 4),
    ...commits,
    ...hashes,
  );
  const unsigned = cat(prefix, stanza);
  const mac = createHmac('sha256', hkdf(K, fid, 'annon/pay2/header'))
    .update(unsigned)
    .digest();
  const headerHash = hex(sha(unsigned, mac));
  const publishText = `Annon: publish a file\ncontract: ${contract}\nfile: ${fileId}\nheader: ${headerHash}`;
  const authorization = await auth(publishText, seller);
  const trailer =
    kind === 2
      ? Buffer.alloc(65)
      : kind === 1
        ? cat(raw(authorization.sig), [0])
        : raw(authorization.sig);
  const header = cat(unsigned, mac, trailer),
    file = cat(header, ...wire);
  const cipher = hex(
    sha(
      'annon/pay2/body',
      [2, chunkLog2],
      fid,
      be(256, 2),
      be(previewLen, 4),
      be(3, 4),
      ...commits,
      ...hashes,
    ),
  );
  const previewPrefix = Buffer.from(prefix);
  previewPrefix[6] = 0;
  previewPrefix.fill(0, 8, 12);
  pay2.push({
    id: seller.kind,
    input: {
      K: hex(K),
      fileId,
      ckdSecret: hex(ckd),
      contractId: contract,
      name,
      mime,
      chunkLog2,
      previewLen,
      data_utf8: data.toString(),
    },
    seller,
    auth_kind: kind,
    cipher_hash: cipher,
    header_hash: headerHash,
    whole_header_hash: hex(sha(header)),
    publish_text: publishText,
    auth: authorization,
    trailer: hex(trailer),
    header: header.toString('base64'),
    file: file.toString('base64'),
    preview: {
      v: 1,
      header: previewPrefix.toString('base64'),
      chunks: [0, 1].map((i) => ({
        index: i,
        key: keys[i].toString('base64'),
        data: wire[i].toString('base64'),
      })),
    },
  });
}
const output = {
  spec: 'near-settlement.md draft v2',
  encoding:
    'All binary hex uses 0x; Solana JSON id is lowercase hex without prefix. Merkle proofs are bottom-up, indexed from zero. PUBLIC test fixtures only.',
  fixtures: { evm_private_key: evmSeed, solana_seed: hex(edSeed) },
  identities,
  terms,
  purchases,
  refunds,
  merkle,
  authorizations,
  pay2,
};
writeFileSync(
  new URL('./near-settlement.json', import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(
  `near-settlement.json: ${identities.length} identities, ${terms.length} terms, ${purchases.length} purchases, ${refunds.length} refund leaves, ${merkle.length} trees, ${pay2.length} PAY2 v2 files`,
);
