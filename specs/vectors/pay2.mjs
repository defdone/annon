// Writes pay2.json: test vectors for specs/pay2.md. A plain encoder on node:crypto, kept apart from
// the SDK (which uses WebCrypto), so the two implementations check each other. Only the seller's
// secp256k1 signature needs @noble, since node:crypto has neither keccak-256 nor recovery ids.
//   node specs/vectors/pay2.mjs
import { createCipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const u8 = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const be = (n, bytes) => {
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64BE(BigInt(n));
  else b.writeUIntBE(n, 0, bytes);
  return b;
};
const sha256 = (...parts) =>
  createHash('sha256')
    .update(u8(...parts))
    .digest();
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
const pattern = (len) => Buffer.from(Array.from({ length: len }, (_, j) => j % 251));

function gcm(key, last, plain) {
  const nonce = Buffer.alloc(12);
  nonce[11] = last ? 1 : 0;
  const c = createCipheriv('aes-256-gcm', key, nonce);
  return u8(c.update(plain), c.final(), c.getAuthTag());
}

function aesKw(kek, key) {
  const c = createCipheriv('id-aes256-wrap', kek, Buffer.from('a6a6a6a6a6a6a6a6', 'hex'));
  return u8(c.update(key), c.final());
}

// Spec 3.1: u16 nameLen ‖ name ‖ u8 mimeLen ‖ mime ‖ u64 size, zero-padded to a multiple of 256.
function metaPiece(name, mime, size, padTo) {
  const n = Buffer.from(name, 'utf8');
  const fields = u8(be(n.length, 2), n, [mime.length], Buffer.from(mime, 'latin1'), be(size, 8));
  const len = padTo ?? Math.ceil(fields.length / 256) * 256;
  return u8(fields, Buffer.alloc(len - fields.length));
}

// Spec 4.1: the EIP-191 text the seller's wallet signs, and the 65-byte r ‖ s ‖ v signature.
export const publishText = (contractId, fileId, headerHash) =>
  `Annon: publish a file\ncontract: ${contractId}\nfile: 0x${hex(fileId)}\nheader: 0x${hex(headerHash)}`;
const eip191 = (text) => {
  const t = Buffer.from(text, 'utf8');
  return keccak_256(u8(`\x19Ethereum Signed Message:\n${t.length}`, t));
};
function signText(priv, text) {
  const rec = secp256k1.sign(eip191(text), priv, { prehash: false, format: 'recovered' });
  return u8(rec.subarray(1), [27 + rec[0]]);
}
const addressOf = (priv) =>
  `0x${hex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`;

// `tamper` lets the invalid vectors play a dishonest seller: it edits pieces, commitments,
// ciphertext, the stanza or the MAC before the seller signs, so only the later checks catch it.
export function encode({
  K,
  fileId,
  ckdSecret,
  contractId,
  name,
  mime,
  data,
  chunkLog2,
  previewLen,
  sellerKey,
  tamper = {},
}) {
  if (!Number.isInteger(chunkLog2) || chunkLog2 < 16 || chunkLog2 > 24)
    throw new RangeError('chunkLog2');
  const C = 2 ** chunkLog2;
  const pieces = [
    tamper.meta ?? metaPiece(name, mime, tamper.size ?? data.length, tamper.metaPadTo),
  ];
  const metaLen = pieces[0].length;
  if (previewLen > 0) pieces.push(data.subarray(0, previewLen));
  const rest = data.subarray(previewLen);
  const m = Math.max(1, Math.ceil(rest.length / C));
  for (let j = 0; j < m; j++) pieces.push(rest.subarray(j * C, (j + 1) * C));
  tamper.pieces?.(pieces);

  const n = pieces.length;
  const keys = pieces.map((_, i) => hkdf(K, fileId, u8('annon/pay2/chunk', be(i, 4))));
  const commits = keys.slice(0, previewLen > 0 ? 2 : 1).map((k) => sha256('annon/pay2/key', k));
  tamper.commits?.(commits);
  const wire = pieces.map((p, i) => gcm(keys[i], i === n - 1, p));
  tamper.wire?.(wire);
  const hashes = wire.map((w) => sha256(w));

  const wrap = hkdf(ckdSecret, fileId, 'annon/pay2/near-ckd/v1');
  const stanzaType = Buffer.from(tamper.stanzaType ?? 'near-ckd/v1');
  const stanzaContract = Buffer.from(tamper.stanzaContract ?? contractId);
  const wrapped = aesKw(wrap, K);
  tamper.wrapped?.(wrapped);
  const stanzaBody = u8([stanzaContract.length], stanzaContract, wrapped);
  const stanza = u8([stanzaType.length], stanzaType, be(stanzaBody.length, 2), stanzaBody);
  const prefixLen = 54 + 32 * (commits.length + n);
  const headerLen = prefixLen + stanza.length + 32 + 65;
  const fixed = u8(
    Buffer.from('PAY2'),
    [2, chunkLog2, 1, 0],
    be(headerLen, 4),
    fileId,
    be(metaLen, 2),
    be(previewLen, 4),
    be(n, 4),
  );
  const unsigned = u8(fixed, ...commits, ...hashes, stanza);
  const mac = createHmac('sha256', hkdf(K, fileId, 'annon/pay2/header'))
    .update(unsigned)
    .digest();
  tamper.mac?.(mac);
  const headerHash = sha256(unsigned, mac);
  const sig = signText(sellerKey, publishText(contractId, fileId, headerHash));
  const file = u8(unsigned, mac, sig, ...wire);
  const cipherHash = sha256(
    'annon/pay2/body',
    [2, chunkLog2],
    fileId,
    be(metaLen, 2),
    be(previewLen, 4),
    be(n, 4),
    ...commits,
    ...hashes,
  );
  return { file, cipherHash, keys, wire, hashes, n, headerLen, prefixLen, headerHash, sig };
}

const hex = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const CONTRACT = 'v1.annon.defdone.near';
// Fixed inputs. ckdSecret is the compressed BLS12-381 G1 generator: a real point in the encoding
// CKD answers decode to. The CKD derivation itself has its own vectors with the key backend.
const base = {
  K: Buffer.alloc(32, 0x4b),
  fileId: Buffer.alloc(32, 0x11),
  ckdSecret: Buffer.from(
    '97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb',
    'hex',
  ),
  contractId: CONTRACT,
  sellerKey: sha256('annon/pay2/vectors/seller'),
};
const SELLER = addressOf(base.sellerKey);

const cases = [
  {
    id: 'empty',
    name: 'empty.bin',
    mime: 'application/octet-stream',
    size: 0,
    chunkLog2: 16,
    previewLen: 0,
  },
  {
    id: 'small',
    name: 'cześć, friend.txt',
    mime: 'text/plain',
    size: 13,
    text: 'hello, friend',
    chunkLog2: 16,
    previewLen: 0,
  },
  {
    id: 'one-full-chunk',
    name: 'full.bin',
    mime: 'application/octet-stream',
    size: 65536,
    chunkLog2: 16,
    previewLen: 0,
  },
  {
    id: 'preview-multi',
    name: 'rows.csv',
    mime: 'text/csv',
    size: 70000,
    chunkLog2: 16,
    previewLen: 1000,
  },
];
const argsOf = (c) => ({ ...base, ...c, data: c.text ? Buffer.from(c.text) : pattern(c.size) });

const valid = cases.map((c) => {
  const out = encode(argsOf(c));
  return {
    id: c.id,
    input: {
      K: hex(base.K),
      fileId: hex(base.fileId),
      ckdSecret: hex(base.ckdSecret),
      sellerKey: hex(base.sellerKey),
      contractId: CONTRACT,
      name: c.name,
      mime: c.mime,
      chunkLog2: c.chunkLog2,
      previewLen: c.previewLen,
      data: c.text ? { utf8: c.text } : { pattern: c.size },
    },
    chunkKeys: out.keys.map(hex),
    chunkHashes: out.hashes.map(hex),
    headerLen: out.headerLen,
    cipherHash: hex(out.cipherHash),
    publishText: publishText(CONTRACT, base.fileId, out.headerHash),
    sellerSig: hex(out.sig),
    fileSha256: hex(sha256(out.file)),
    file: b64(out.file),
  };
});

// The preview a seller of 'preview-multi' publishes: the header up to the end of the hash list,
// plus the metadata chunk and the preview chunk with their keys.
// Spec 7: a package has no stanzas, so stanza count and headerLen are 0.
const previewPrefix = (header) => {
  const p = Buffer.from(header);
  p[6] = 0;
  p.fill(0, 8, 12);
  return p;
};
const packageOf = (out, keys = out.keys) => ({
  v: 1,
  header: b64(previewPrefix(out.file.subarray(0, out.prefixLen))),
  chunks: [0, 1].map((i) => ({ index: i, key: b64(keys[i]), data: b64(out.wire[i]) })),
});
const pm = encode(argsOf(cases[3]));
const pmHash = hex(pm.cipherHash);
const pkg = packageOf(pm);
const editPkg = (fn) => {
  const p = structuredClone(pkg);
  fn(p);
  return p;
};
const lie = encode({ ...argsOf(cases[3]), tamper: { size: 2 ** 53 - 1 } });
const preview = {
  of: 'preview-multi',
  package: pkg,
  expect: { name: 'rows.csv', mime: 'text/csv', size: 70000, preview: { pattern: 1000 } },
  invalid: [
    {
      id: 'preview-other-key',
      package: editPkg((p) => {
        p.chunks[1].key = b64(Buffer.alloc(32, 7));
      }),
      expect: 'preview_invalid',
    },
    {
      id: 'preview-data-edited',
      package: editPkg((p) => {
        const d = Buffer.from(p.chunks[1].data, 'base64');
        d[0] ^= 1;
        p.chunks[1].data = b64(d);
      }),
      expect: 'preview_invalid',
    },
    {
      id: 'preview-index-2',
      package: editPkg((p) => {
        p.chunks[1].index = 2;
      }),
      expect: 'preview_invalid',
    },
    { id: 'preview-other-file', package: pkg, fileId: '22'.repeat(32), expect: 'file_id_mismatch' },
    {
      id: 'preview-no-chunks',
      package: editPkg((p) => {
        p.chunks = [];
      }),
      expect: 'preview_invalid',
    },
    {
      id: 'preview-base64-with-newline',
      package: editPkg((p) => {
        p.chunks[1].data = `${p.chunks[1].data.slice(0, 40)}\n${p.chunks[1].data.slice(40)}`;
      }),
      expect: 'preview_invalid',
    },
    // Decodes to the right 32 bytes, but isn't the one canonical encoding.
    {
      id: 'preview-key-unpadded',
      package: editPkg((p) => {
        p.chunks[0].key = p.chunks[0].key.replace(/=+$/, '');
      }),
      expect: 'preview_invalid',
    },
    {
      id: 'preview-chunk-size-edited',
      package: editPkg((p) => {
        const h = Buffer.from(p.header, 'base64');
        h[5] = 17;
        p.header = b64(h);
      }),
      expect: 'cipher_hash_mismatch',
    },
    {
      id: 'preview-wrong-registration',
      package: pkg,
      registered: '00'.repeat(32),
      expect: 'cipher_hash_mismatch',
    },
    // The header has 4 chunks, so a 2^53 - 1 byte file is impossible before anyone pays.
    {
      id: 'preview-size-lie',
      package: packageOf(lie),
      registered: hex(lie.cipherHash),
      expect: 'meta_invalid',
    },
  ].map((v) => ({ registered: pmHash, fileId: hex(base.fileId), ...v })),
};

// Mutations of 'small' unless stated. Each case is opened against a listing: the registration the
// contract holds (fileId, cipherHash, seller). `host-*` edit the bytes after the seller signed;
// `seller-*` are built and signed by a dishonest seller who holds K, so only later steps catch them.
const small = valid[1];
const smallFile = Buffer.from(small.file, 'base64');
const edit = (fn) => {
  const f = Buffer.from(smallFile);
  fn(f);
  return f;
};
const stanzaAt = 54 + 32 * (1 + 2); // 'small': one commitment, two chunk hashes
const macAt = small.headerLen - 97;
const sigAt = small.headerLen - 65;
const flip = (at) =>
  edit((f) => {
    f[at] ^= 1;
  });
const N = secp256k1.Point.Fn.ORDER;
const highS = edit((f) => {
  const s = BigInt(`0x${hex(f.subarray(sigAt + 32, sigAt + 64))}`);
  f.set(Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex'), sigAt + 32);
  f[sigAt + 64] = f[sigAt + 64] === 27 ? 28 : 27; // the same signature, made malleable
});
const invalid = [
  {
    id: 'bad-magic',
    file: edit((f) => {
      f[3] = 0x31;
    }),
    expect: 'bad_magic',
  },
  {
    id: 'unknown-version',
    file: edit((f) => {
      f[4] = 1;
    }),
    expect: 'unsupported_version',
  },
  {
    id: 'chunk-log2-too-big',
    file: edit((f) => {
      f[5] = 25;
    }),
    expect: 'bad_chunk_size',
  },
  {
    id: 'no-stanzas',
    file: edit((f) => {
      f[6] = 0;
    }),
    expect: 'bad_header',
  },
  {
    id: 'reserved-set',
    file: edit((f) => {
      f[7] = 3;
    }),
    expect: 'bad_header',
  },
  {
    id: 'header-too-large',
    file: edit((f) => {
      f.writeUInt32BE(65537, 8);
    }),
    expect: 'header_too_large',
  },
  {
    id: 'header-len-mismatch',
    file: edit((f) => {
      f.writeUInt32BE(small.headerLen + 1, 8);
    }),
    expect: 'bad_header',
  },
  {
    id: 'meta-len-not-256',
    file: edit((f) => {
      f.writeUInt16BE(300, 44);
    }),
    expect: 'bad_header',
  },
  {
    id: 'preview-too-long',
    file: edit((f) => {
      f.writeUInt32BE(65537, 46);
    }),
    expect: 'bad_header',
  },
  {
    id: 'chunk-count-too-big',
    file: edit((f) => {
      f.writeUInt32BE(1025, 50);
    }),
    expect: 'bad_header',
  },
  { id: 'other-file', file: smallFile, fileId: '22'.repeat(32), expect: 'file_id_mismatch' },
  { id: 'commitment-edited', file: flip(60), expect: 'cipher_hash_mismatch' },
  { id: 'hash-list-edited', file: flip(54 + 32 + 5), expect: 'cipher_hash_mismatch' },
  {
    id: 'wrong-registration',
    file: smallFile,
    registered: '00'.repeat(32),
    expect: 'cipher_hash_mismatch',
  },
  {
    id: 'wrong-seller',
    file: smallFile,
    seller: `0x${'00'.repeat(20)}`,
    expect: 'seller_signature_invalid',
  },
  { id: 'host-stanza-edited', file: flip(stanzaAt + 1), expect: 'seller_signature_invalid' },
  { id: 'host-wrapped-key-edited', file: flip(macAt - 1), expect: 'seller_signature_invalid' },
  { id: 'host-mac-edited', file: flip(macAt), expect: 'seller_signature_invalid' },
  { id: 'host-sig-edited', file: flip(sigAt + 5), expect: 'seller_signature_invalid' },
  { id: 'host-sig-high-s', file: highS, expect: 'seller_signature_invalid' },
  {
    id: 'body-byte-edited',
    file: edit((f) => {
      f[f.length - 1] ^= 1;
    }),
    expect: 'chunk_hash_mismatch',
  },
  {
    id: 'body-truncated',
    file: smallFile.subarray(0, small.headerLen + 256 + 16 + 5),
    expect: 'bad_body_length',
  },
  {
    id: 'body-extended',
    file: Buffer.concat([smallFile, Buffer.alloc(65536)]),
    expect: 'bad_body_length',
  },
  ...[
    {
      id: 'seller-unknown-stanza-only',
      tamper: { stanzaType: 'mear-ckd/v1' },
      expect: 'no_usable_stanza',
    },
    {
      id: 'seller-other-contract',
      tamper: { stanzaContract: 'w1.annon.defdone.near' },
      expect: 'no_usable_stanza',
    },
    {
      id: 'seller-wrapped-key-edited',
      tamper: {
        wrapped: (w) => {
          w[39] ^= 1;
        },
      },
      expect: 'key_unwrap_failed',
    },
    {
      id: 'seller-mac-edited',
      tamper: {
        mac: (m) => {
          m[0] ^= 1;
        },
      },
      expect: 'header_mac_invalid',
    },
    {
      id: 'seller-bad-gcm',
      tamper: {
        wire: (w) => {
          w[1][0] ^= 1;
        },
      },
      expect: 'chunk_invalid',
    },
    {
      id: 'seller-bad-commitment',
      tamper: {
        commits: (c) => {
          c[0] = Buffer.alloc(32, 9);
        },
      },
      expect: 'chunk_invalid',
    },
    { id: 'seller-wrong-size', tamper: { size: 14 }, expect: 'meta_invalid' },
    { id: 'seller-meta-not-minimal', tamper: { metaPadTo: 512 }, expect: 'meta_invalid' },
    {
      id: 'seller-meta-bad-utf8',
      tamper: { meta: u8(be(1, 2), [0xff], [0], be(13, 8), Buffer.alloc(256 - 12)) },
      expect: 'meta_invalid',
    },
    {
      id: 'seller-meta-bad-mime',
      tamper: { meta: u8(be(1, 2), 'a', [1], [0x0a], be(13, 8), Buffer.alloc(256 - 13)) },
      expect: 'meta_invalid',
    },
    {
      id: 'seller-meta-padding',
      tamper: { meta: u8(be(1, 2), 'a', [0], be(13, 8), [1], Buffer.alloc(256 - 13)) },
      expect: 'meta_invalid',
    },
    // Framing allows an empty last chunk after a full one; the count check must still refuse it.
    {
      id: 'seller-empty-last-chunk',
      args: argsOf(cases[2]),
      tamper: { pieces: (p) => p.push(Buffer.alloc(0)) },
      expect: 'meta_invalid',
    },
  ].map(({ id, args = argsOf(cases[1]), tamper, expect }) => {
    const out = encode({ ...args, tamper });
    return { id, file: out.file, registered: hex(out.cipherHash), expect };
  }),
].map((v) => ({
  id: v.id,
  listing: {
    fileId: v.fileId ?? hex(base.fileId),
    cipherHash: v.registered ?? small.cipherHash,
    seller: v.seller ?? SELLER,
  },
  expect: v.expect,
  file: b64(v.file),
}));

writeFileSync(
  new URL('./pay2.json', import.meta.url),
  `${JSON.stringify({ spec: 'specs/pay2.md', contractId: CONTRACT, seller: SELLER, valid, preview, invalid }, null, 1)}\n`,
);
console.log(
  `pay2.json: ${valid.length} valid, 1 preview (${preview.invalid.length} invalid), ${invalid.length} invalid`,
);
