/**
 * The CLI's payment or listing terms attached to a signing request (`SigningRequest.terms`). They
 * are review context, not what the wallet signs: the page shows them apart from the signed request
 * and warns when their price differs from the amount the request signs.
 */
import { formatUnits, record, text } from './login-format.js';

type Row = { label: string; value: string; mono?: boolean };

/** `{kind, id}` as `NEAR alice.near` or `EVM 0x...`; anything else as plain text. */
const identity = (v: unknown) => {
  const i = record(v);
  return typeof i.kind === 'string' && typeof i.id === 'string'
    ? `${i.kind === 'evm' ? 'EVM' : i.kind === 'near' ? 'NEAR' : i.kind === 'solana' ? 'Solana' : i.kind} ${i.id}`
    : text(v);
};
const near = (v: unknown) => (/^[0-9]+$/.test(text(v)) ? `${formatUnits(v, 24)} NEAR` : text(v));

/** Split recipients with their share; the remainder recipient also gets the rounding rest. */
function split(recipients: unknown, remainder: unknown): Row[] {
  if (!Array.isArray(recipients)) return [];
  return recipients.map((r, i) => {
    const bps = Number(record(r).bps);
    const share = Number.isInteger(bps) ? `${(bps / 100).toFixed(2)}%` : text(record(r).bps);
    return {
      label: recipients.length === 1 ? 'Paid to' : `Recipient ${i + 1}`,
      value: `${identity(record(r).identity)} ${share}${i === remainder ? ', plus the rounding remainder' : ''}`,
      mono: true,
    };
  });
}

export function describeTerms(
  terms: unknown,
  signedPrice?: string,
): { rows: Row[]; warnings: string[] } {
  const t = record(terms);
  if (!Object.keys(t).length) return { rows: [], warnings: [] };
  const s = record(t.split);
  const source = record(t.source);
  const optional = (label: string, v: unknown, mono = true, format = text): Row[] =>
    v === undefined || v === null || v === '' ? [] : [{ label, value: format(v), mono }];
  const rows: Row[] = [
    ...optional('File', t.file),
    ...optional('Resource', t.resource),
    ...optional('Seller', t.seller, true, identity),
    ...optional('Host', t.host),
    ...optional('Contract', t.contract),
    ...optional('Route', t.route, false),
    ...optional('Price', t.price, false, (v) => `${formatUnits(v, 6)} USDC`),
    ...optional('Token', t.token),
    ...split(t.recipients ?? s.recipients, t.remainder ?? s.remainder),
    ...optional('Base payout address', t.baseRecipient),
    ...optional('Protocol fee', t.fee, false),
    ...optional('Listing storage', t.listingStorage, false, near),
    ...optional('Purchase storage', t.purchaseStorage, false, near),
    ...(Object.keys(source).length
      ? [
          {
            label: 'Pay from',
            value: `${text(source.amountFormatted ?? source.amount)} ${text(source.symbol ?? source.asset)} on ${text(source.chain)}`,
          },
          ...optional('Deposit before', source.depositBefore, false),
        ]
      : []),
  ];
  const price = text(t.price);
  return {
    rows,
    warnings:
      signedPrice !== undefined && price && price !== signedPrice
        ? [
            `The CLI's terms say ${formatUnits(price, 6)} USDC, but the request signs ${formatUnits(signedPrice, 6)}. Do not approve.`,
          ]
        : [],
  };
}
