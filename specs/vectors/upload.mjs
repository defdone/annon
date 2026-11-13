// Independent UTF-8, PAY2 body, seller authorization and reservation vectors.
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
} from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const concat = (...v) => Buffer.concat(v.map((x) => Buffer.from(x)));
const sha = (...v) =>
  createHash('sha256')
    .update(concat(...v))
    .digest();
const hex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const be = (n, size) => {
  const b = Buffer.alloc(size);
  b.writeUIntBE(n, 0, size);
  return b;
};
const le = (n, size) => {
  const b = Buffer.alloc(size);
  let v = BigInt(n);
  for (let i = 0; i < size; i++) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
};
const str = (s) => concat(le(Buffer.byteLength(s), 4), Buffer.from(s));
const base58 = (value) => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${Buffer.from(value).toString('hex')}`),
    out = '';
  while (n > 0) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
};
const idText = (id) =>
  id.kind === 'evm'
    ? `EVM ${id.id}`
    : id.kind === 'near'
      ? `NEAR ${id.id}`
      : `Solana ${base58(Buffer.from(id.id, 'hex'))}`;
const uploadText = (i) =>
  [
    'Annon: reserve encrypted file hosting',
    `network: ${i.network}`,
    `contract: ${i.contract}`,
    `seller: ${idText(i.seller)}`,
    `file: ${i.fileId}`,
    `cipher: ${i.cipherHash}`,
    `terms: ${i.termsHash}`,
    `bytes: ${i.byteSize}`,
    `plaintext bytes: ${i.plaintextSize}`,
    `header bytes: ${i.headerSize}`,
    `host: ${i.hostOrigin}`,
    `metadata: ${i.metadataHash}`,
    `nonce: ${i.nonce}`,
    `expires: ${i.expiresAt}`,
  ].join('\n');
const evidence = (text) => ({
  text,
  utf8Hex: Buffer.from(text).toString('hex'),
  utf8Length: Buffer.byteLength(text),
  sha256: sha(text).toString('hex'),
});
const illustrative = {
  network: 'near:mainnet',
  contract: 'market.synthetic.near',
  seller: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
  fileId: `0x${'22'.repeat(32)}`,
  cipherHash: `0x${'33'.repeat(32)}`,
  termsHash: `0x${'44'.repeat(32)}`,
  byteSize: 1635,
  plaintextSize: 1024,
  headerSize: 323,
  hostOrigin: 'https://demo.annon.dev',
  metadataHash: `0x${'55'.repeat(32)}`,
  nonce: `0x${'66'.repeat(32)}`,
  expiresAt: 1794528600,
};
const frozen = evidence(uploadText(illustrative));
if (
  frozen.utf8Length !== 620 ||
  frozen.sha256 !== '3a55e8edcb0fc61f2c9ca3a03f347dd0b50247ac457f8eb80a777e5b4c6e5e9b'
)
  throw new Error('Signing text changed.');
const K = Buffer.alloc(32, 3),
  fileId = Buffer.alloc(32, 2),
  plaintext = Buffer.alloc(1024, 8);
const metadata = { filename: 'file.txt', title: 'File', description: 'Synthetic encrypted upload' };
const fields = concat(
  be(8, 2),
  'file.txt',
  [10],
  'text/plain',
  Buffer.from('0000000000000400', 'hex'),
);
const meta = concat(fields, Buffer.alloc(256 - fields.length));
const keys = [0, 1].map((i) =>
  Buffer.from(hkdfSync('sha256', K, fileId, concat('annon/pay2/chunk', be(i, 4)), 32)),
);
const wire = [meta, plaintext].map((p, i) => {
  const iv = Buffer.alloc(12);
  iv[11] = i === 1 ? 1 : 0;
  const c = createCipheriv('aes-256-gcm', keys[i], iv);
  return concat(c.update(p), c.final(), c.getAuthTag());
});
const commits = [sha('annon/pay2/key', keys[0])],
  hashes = wire.map((p) => sha(p));
const cipher = sha(
  'annon/pay2/body',
  [2, 22],
  fileId,
  be(256, 2),
  be(0, 4),
  be(2, 4),
  ...commits,
  ...hashes,
);
const manifest = {
  version: 2,
  chunkLog2: 22,
  metaLen: 256,
  previewLen: 0,
  n: 2,
  keyCommitments: commits.map(hex),
  chunkHashes: hashes.map(hex),
};
const encodeId = (id) =>
  id.kind === 'near'
    ? concat([2], str(id.id))
    : concat([id.kind === 'evm' ? 0 : 1], Buffer.from(id.id.replace(/^0x/, ''), 'hex'));
const nearToken = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const termsFor = (seller) => ({
  network: 'near:mainnet',
  contract: 'market.synthetic.near',
  file_id: hex(fileId),
  seller,
  pay2_version: 2,
  cipher_hash: hex(cipher),
  moderator: null,
  near: {
    token: nearToken,
    price: '100000',
    recipients: [{ identity: seller, bps: 10000 }],
    remainder: 0,
  },
  base: null,
});
const hashTerms = (t) =>
  hex(
    sha(
      'annon/terms/v2',
      [0],
      str(t.network),
      str(t.contract),
      fileId,
      encodeId(t.seller),
      [2],
      cipher,
      [0],
      str(nearToken),
      le(100000, 16),
      le(1, 4),
      encodeId(t.seller),
      le(10000, 2),
      [0, 0],
    ),
  );
const evmKey = Buffer.alloc(32, 1);
const evm = {
  kind: 'evm',
  id: hex(keccak_256(secp256k1.getPublicKey(evmKey, false).subarray(1)).subarray(12)),
};
const edSeed = Buffer.alloc(32, 8);
const edKey = createPrivateKey({
  key: concat(Buffer.from('302e020100300506032b657004220420', 'hex'), edSeed),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey(edKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const solana = { kind: 'solana', id: publicKey.toString('hex') },
  near = { kind: 'near', id: 'seller.synthetic.near' };
const cases = [evm, solana, near].map((seller) => {
  const terms = termsFor(seller);
  const intent = {
    ...illustrative,
    seller,
    fileId: hex(fileId),
    cipherHash: hex(cipher),
    termsHash: hashTerms(terms),
    metadataHash: hex(sha(JSON.stringify(Object.values(metadata)))),
  };
  const text = uploadText(intent),
    message = Buffer.from(text);
  let auth, signatureInput;
  if (seller.kind === 'evm') {
    signatureInput = Buffer.from(
      keccak_256(concat(`\x19Ethereum Signed Message:\n${message.length}`, message)),
    );
    const recovered = secp256k1.sign(signatureInput, evmKey, {
      prehash: false,
      format: 'recovered',
    });
    auth = { kind: 'evm', sig: hex(concat(recovered.subarray(1), [27 + recovered[0]])) };
  } else if (seller.kind === 'solana') {
    signatureInput = message;
    auth = { kind: 'solana', sig: hex(sign(null, signatureInput, edKey)) };
  } else {
    signatureInput = sha(
      le(2147484061, 4),
      str(text),
      Buffer.from(intent.nonce.slice(2), 'hex'),
      str(intent.hostOrigin),
      [0],
    );
    auth = {
      kind: 'near',
      accountId: seller.id,
      publicKey: `ed25519:${base58(publicKey)}`,
      signature: sign(null, signatureInput, edKey).toString('base64'),
    };
  }
  return {
    request: { intent, terms, manifest, metadata, auth },
    ...evidence(text),
    signatureInputHex: signatureInput.toString('hex'),
  };
});
const i = cases[0].request.intent;
const reservation = {
  v: 1,
  uploadId: 'ab'.repeat(32),
  network: i.network,
  contract: i.contract,
  fileId: i.fileId,
  termsHash: i.termsHash,
  seller: i.seller,
  cipherHash: i.cipherHash,
  byteSize: i.byteSize,
  plaintextSize: i.plaintextSize,
  headerSize: i.headerSize,
  metadataHash: i.metadataHash,
  hostOrigin: i.hostOrigin,
  issuedAt: 1794528000,
  expiresAt: 1794528600,
};
const reservationText = [
  'Annon: hosting reservation v1',
  `upload: ${reservation.uploadId}`,
  `network: ${i.network}`,
  `contract: ${i.contract}`,
  `file: ${i.fileId}`,
  `terms: ${i.termsHash}`,
  `seller: ${idText(i.seller)}`,
  `cipher: ${i.cipherHash}`,
  `bytes: ${i.byteSize}`,
  `plaintext bytes: ${i.plaintextSize}`,
  `header bytes: ${i.headerSize}`,
  `metadata: ${i.metadataHash}`,
  `host: ${i.hostOrigin}`,
  `issued: ${reservation.issuedAt}`,
  `expires: ${reservation.expiresAt}`,
].join('\n');
const reservationKey = createPrivateKey({
  key: concat(Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)),
  format: 'der',
  type: 'pkcs8',
});
reservation.signature = sign(null, Buffer.from(reservationText), reservationKey).toString(
  'base64url',
);
const output = {
  illustrative: { intent: illustrative, ...frozen },
  framing: { contractBytes: 21, bodyBytes: 1312, headerBytes: 323, byteSize: 1635 },
  bodyHex: concat(...wire).toString('hex'),
  cases,
  reservation: {
    input: reservation,
    publicKey: createPublicKey(reservationKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('hex'),
    ...evidence(reservationText),
  },
};
writeFileSync(new URL('./upload.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(`upload.json: ${cases.length} seller signatures and one hosting reservation`);
