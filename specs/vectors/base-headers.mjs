// Real Base mainnet block headers: the RPC's JSON fields, their RLP encoding and the block hash.
// The contract hashes the RLP and reads the timestamp; the SDK rebuilds the RLP from the JSON.
// Re-encodes the recorded RPC responses offline by default; refresh explicitly with:
//   BASE_RPC=https://base-rpc.publicnode.com node specs/vectors/base-headers.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';

const RPC = process.env.BASE_RPC;
const recorded = JSON.parse(readFileSync(new URL('./base-headers.json', import.meta.url))).cases;
const BLOCKS = [
  [53466533, 'a 2 s block before Denim'],
  [53556127, 'the last 2 s block'],
  [53556128, 'the first 200 ms block'],
  [53556129, 'a 200 ms block with the same timestamp as its parent'],
  [53897014, 'a block a day after Denim'],
];
// Header fields in RLP order (Prague / Isthmus); the RPC returns more, these are hashed.
const FIELDS = [
  ['parentHash', 'bytes'],
  ['sha3Uncles', 'bytes'],
  ['miner', 'bytes'],
  ['stateRoot', 'bytes'],
  ['transactionsRoot', 'bytes'],
  ['receiptsRoot', 'bytes'],
  ['logsBloom', 'bytes'],
  ['difficulty', 'int'],
  ['number', 'int'],
  ['gasLimit', 'int'],
  ['gasUsed', 'int'],
  ['timestamp', 'int'],
  ['extraData', 'bytes'],
  ['mixHash', 'bytes'],
  ['nonce', 'bytes'],
  ['baseFeePerGas', 'int'],
  ['withdrawalsRoot', 'bytes'],
  ['blobGasUsed', 'int'],
  ['excessBlobGas', 'int'],
  ['parentBeaconBlockRoot', 'bytes'],
  ['requestsHash', 'bytes'],
];

const fromHex = (h) =>
  Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const toHex = (b) => `0x${Buffer.from(b).toString('hex')}`;
const int = (h) =>
  BigInt(h) === 0n
    ? new Uint8Array()
    : fromHex(
        `0x${BigInt(h)
          .toString(16)
          .padStart(Math.ceil(BigInt(h).toString(16).length / 2) * 2, '0')}`,
      );
const length = (n, offset) => {
  if (n < 56) return [offset + n];
  const b = fromHex(`0x${n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0')}`);
  return [offset + 55 + b.length, ...b];
};
const item = (b) => (b.length === 1 && b[0] < 0x80 ? [...b] : [...length(b.length, 0x80), ...b]);
const list = (items) => {
  const body = items.flatMap(item);
  return Uint8Array.from([...length(body.length, 0xc0), ...body]);
};

const rpc = async (method, params) => {
  const r = await (
    await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json();
  if (!r.result) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};

const cases = [];
for (const [n, note] of BLOCKS) {
  const snapshot = recorded.find((c) => c.number === n);
  const b = RPC
    ? await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false])
    : { ...snapshot.json, hash: snapshot.hash };
  const json = Object.fromEntries(FIELDS.map(([k]) => [k, b[k]]));
  const rlp = list(FIELDS.map(([k, t]) => (t === 'int' ? int(b[k]) : fromHex(b[k]))));
  const hash = toHex(keccak_256(rlp));
  if (hash !== b.hash) throw new Error(`block ${n}: rebuilt header does not hash to ${b.hash}`);
  cases.push({
    note,
    number: n,
    timestamp: Number.parseInt(b.timestamp, 16),
    hash,
    json,
    rlp: toHex(rlp),
  });
}
writeFileSync(
  new URL('./base-headers.json', import.meta.url),
  `${JSON.stringify({ source: 'Base mainnet, eth_getBlockByNumber', cases }, null, 1)}\n`,
);
console.log(`${cases.length} headers, every one hashes to its block hash`);
