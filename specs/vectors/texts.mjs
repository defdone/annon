// Independent authoritative text fixtures, replacing all retired registration/wallet texts.
import { readFileSync, writeFileSync } from 'node:fs';

const v = JSON.parse(readFileSync(new URL('./near-settlement.json', import.meta.url)));
const utc = (n) => `${new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const text = (id) =>
  v.identities.find((x) => JSON.stringify(x.identity) === JSON.stringify(id)).text;
const cases = [
  ...v.terms.map((t) => ({
    id: t.id,
    contractId: t.terms.contract,
    kind: 'register',
    args: { terms: t.terms, seller_key: t.seller_key, deadline: t.deadline },
    text: t.register_text,
  })),
  ...v.purchases.map((p) => ({
    id: p.id,
    contractId: p.reopen.contract,
    kind: 'reopen',
    args: p.reopen,
    text: p.reopen_text,
  })),
  ...v.terms.flatMap((t) => {
    const contractId = t.terms.contract,
      seller = t.terms.seller,
      deadline = t.deadline,
      file_id = t.terms.file_id;
    return [
      {
        id: `stop-${t.id}`,
        contractId,
        kind: 'stop_sales',
        seller,
        args: { file_id, key: null, deadline },
        text: `Annon: stop selling a file\nSigning this is final: the file can't be sold again. Past buyers keep access.\ncontract: ${contractId}\nfile: ${file_id}\nseller: ${text(seller)}\nvalid until: ${utc(deadline)}`,
      },
      {
        id: `seller-${t.id}`,
        contractId,
        kind: 'reopen_seller',
        seller,
        args: { file_id, key: t.seller_key, deadline },
        text: `Annon: open a file again\nSigning this lets whoever holds the one-time key below open the file.\ncontract: ${contractId}\nfile: ${file_id}\nseller: ${text(seller)}\none-time key: ${t.seller_key}\nvalid until: ${utc(deadline)}`,
      },
      {
        id: `funding-${t.id}`,
        contractId,
        network: t.terms.network,
        kind: 'fund_file_storage',
        seller,
        args: {
          file_id,
          amount: '41000000000000000000000',
          nonce: `0x${'33'.repeat(32)}`,
          deadline,
        },
        text: `Annon: request sponsored file storage\nnetwork: ${t.terms.network}\ncontract: ${contractId}\nseller: ${text(seller)}\nfile: ${file_id}\namount: 41000000000000000000000\nnonce: 0x${'33'.repeat(32)}\nexpires: ${deadline}`,
      },
    ];
  }),
];
writeFileSync(
  new URL('./texts.json', import.meta.url),
  `${JSON.stringify({ source: 'Independent draft-3 commitments and register.rs seller text shapes (10 Nov)', cases }, null, 2)}\n`,
);
console.log(`texts.json: ${cases.length} authoritative texts`);
