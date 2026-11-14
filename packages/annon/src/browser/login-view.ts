/**
 * What the approval page shows for one signing request. Every value comes from the request object
 * the page signs (`operation`, `chain`, `account`, `expiresAt`, `payload`); `terms` is the CLI's
 * review context and is shown apart from it, labelled as such. Pure functions: the DOM code sets
 * each returned string as text, never as markup.
 */
import type { SigningRequest } from '../node/signing.js';
import { BASE_USDC, NEAR_USDC } from '../settle-near/terms.js';
import { formatUnits, nonceHex, record, secondsTime, text } from './login-format.js';
import { describeTerms } from './login-terms.js';

export interface Row {
  label: string;
  value: string;
  /** Addresses, hashes and other values a person compares character by character. */
  mono?: boolean;
}
export interface Summary {
  title: string;
  /** The headline amount of a payment, e.g. `0.2 USDC`. */
  amount?: string;
  rows: Row[];
  /** The exact text a wallet signs, or the arguments of a transaction. */
  message?: { label: string; text: string };
  /** What signing does and does not do. */
  note: string;
  /** The CLI's payment or listing terms, when the request carries them. */
  terms: Row[];
  warnings: string[];
}

/** The whole request as JSON, with a NEP-413 nonce as hex instead of 32 numbers. */
export function technicalDetails(q: SigningRequest): string {
  const payload = record(q.payload);
  return JSON.stringify(
    q.operation === 'near.nep413' && 'nonce' in payload
      ? { ...q, payload: { ...payload, nonce: nonceHex(payload.nonce) } }
      : q,
    null,
    2,
  );
}

const NETWORKS: Record<string, string> = {
  'near:mainnet': 'NEAR mainnet',
  'near:testnet': 'NEAR testnet',
  'near:sandbox': 'NEAR sandbox',
  'eip155:8453': 'Base',
};
export const networkName = (chain: string) =>
  NETWORKS[chain] ? `${NETWORKS[chain]} (${chain})` : chain;

/** Signed texts the SDK and CLI produce, by their first line. */
const TEXTS: readonly (readonly [prefix: string, title: string])[] = [
  ['Annon: list a file for sale', 'Sign the listing terms'],
  ['Annon: publish a file', 'Publish a file'],
  ['Annon: reserve encrypted file hosting', 'Reserve file hosting'],
  ['Annon: verify purchase recovery', 'Prove you can recover a purchase'],
  ['Annon: open a purchased file again', 'Open a purchased file again'],
  ['Annon: open a file again', 'Open a listed file again'],
  ['Annon: stop selling a file', 'Stop selling a file'],
  ['Annon: request sponsored file storage', 'Request sponsored file storage'],
];
const LOGIN = 'Annon login: ';
const OFF_CHAIN =
  'Your wallet signs exactly this text. Annon uses the signature only as your approval of what it says. Signing sends no transaction from your wallet.';

/** Characters that hide or reorder text: controls other than tab and newline, bidi overrides, zero-width marks. */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hasHidden = (s: string) =>
  [...s].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return HIDDEN.some(([from, to]) => n >= from && n <= to);
  });
const hiddenWarning = (s: string) =>
  hasHidden(s)
    ? [
        'The text contains invisible or direction-changing characters. Check it in Technical details.',
      ]
    : [];

function signedText(q: SigningRequest, kind: string, extra: Row[]): Summary {
  const message = text(record(q.payload).message);
  const login = message.startsWith(LOGIN);
  const known = TEXTS.find(([prefix]) => message === prefix || message.startsWith(`${prefix}\n`));
  const near = q.operation === 'near.nep413';
  return {
    title: login
      ? `Sign in with your ${near ? 'NEAR' : 'EVM'} wallet`
      : (known?.[1] ?? 'Sign a message'),
    rows: [
      { label: 'Action', value: kind },
      { label: 'Network', value: networkName(q.chain) },
      {
        label: near ? 'Account' : 'Address',
        value: q.account || 'Chosen in your wallet',
        mono: !!q.account,
      },
      ...extra,
    ],
    message: { label: 'Text to sign', text: message },
    note: login
      ? `This proves you control the ${near ? 'account' : 'address'}. It adds no key and sends no transaction.`
      : known?.[0] === 'Annon: verify purchase recovery'
        ? 'This proves you control the recovery identity named in the text. It sends no transaction and moves no funds.'
        : OFF_CHAIN,
    terms: [],
    warnings: hiddenWarning(message),
  };
}

function typedData(q: SigningRequest): Summary {
  const p = record(q.payload);
  const domain = record(p.domain);
  const m = record(p.message);
  const contract = text(domain.verifyingContract);
  const chain = `eip155:${text(domain.chainId)}`;
  const usdc =
    p.primaryType === 'TransferWithAuthorization' &&
    contract.toLowerCase() === BASE_USDC &&
    chain === 'eip155:8453';
  const warnings = chain === q.chain ? [] : [`The typed data names ${chain}, not ${q.chain}.`];
  if (p.primaryType !== 'TransferWithAuthorization' || !usdc)
    return {
      title: 'Sign typed data',
      rows: [
        { label: 'Action', value: `Sign EIP-712 data (${text(p.primaryType)})` },
        { label: 'Network', value: networkName(q.chain) },
        { label: 'Address', value: q.account || 'Chosen in your wallet', mono: !!q.account },
        { label: 'Contract', value: contract, mono: true },
      ],
      message: { label: 'Data to sign', text: JSON.stringify(m, null, 2) },
      note: 'Your wallet signs this data. Signing sends no transaction from your wallet.',
      terms: [],
      warnings: [...warnings, 'This is not a USDC transfer the page recognises. Read the data.'],
    };
  const amount = `${formatUnits(m.value, 6)} USDC`;
  return {
    title: 'Approve a payment',
    amount,
    rows: [
      { label: 'Action', value: 'Authorize a USDC transfer (EIP-3009)' },
      { label: 'Network', value: networkName(q.chain) },
      { label: 'Amount', value: amount },
      { label: 'To', value: text(m.to), mono: true },
      { label: 'From', value: text(m.from) || q.account, mono: true },
      { label: 'Token', value: `USDC ${contract}`, mono: true },
      { label: 'Valid until', value: secondsTime(m.validBefore) },
      { label: 'Authorization nonce', value: text(m.nonce), mono: true },
    ],
    note: 'Signing sends no transaction and costs no gas. It authorizes this exact USDC transfer, which can be submitted on Base once, until the time shown. After that it is void.',
    terms: [],
    warnings: [
      ...warnings,
      ...(q.account && text(m.from).toLowerCase() !== q.account.toLowerCase()
        ? [`The transfer is from ${text(m.from)}, not the requested ${q.account}.`]
        : []),
    ],
  };
}

const gas = (v: unknown) => {
  const raw = text(v);
  return /^[0-9]+$/.test(raw) ? `${formatUnits(raw, 12)} Tgas` : raw;
};
const yocto = (v: unknown) => {
  const raw = text(v);
  return !/^[0-9]+$/.test(raw)
    ? raw
    : raw === '0'
      ? 'None'
      : raw.length < 19
        ? `${raw} yoctoNEAR`
        : `${formatUnits(raw, 24)} NEAR`;
};

function transaction(q: SigningRequest): Summary {
  const p = record(q.payload);
  const args = record(p.args);
  const receiver = text(p.receiverId);
  const from = { label: 'From account', value: q.account || 'Chosen in your wallet', mono: true };
  const sends = 'Your wallet sends this transaction from your account and pays its gas in NEAR.';
  if (p.method !== 'ft_transfer_call')
    return {
      title: 'Approve a NEAR transaction',
      rows: [
        { label: 'Action', value: `Call ${text(p.method)}` },
        { label: 'Network', value: networkName(q.chain) },
        from,
        { label: 'Contract', value: receiver, mono: true },
        { label: 'Deposit', value: yocto(p.deposit) },
        { label: 'Gas limit', value: gas(p.gas) },
      ],
      message: { label: 'Arguments', text: JSON.stringify(p.args ?? {}, null, 2) },
      note: `${sends} ${p.deposit === '0' ? 'It attaches no deposit.' : 'It attaches the deposit shown.'}`,
      terms: [],
      warnings: [],
    };
  let msg: Record<string, unknown> = {};
  try {
    msg = record(JSON.parse(text(args.msg)));
  } catch {}
  const usdc =
    receiver === NEAR_USDC || (msg.route === 'near-usdc' && text(msg.asset) === receiver);
  const amount = usdc
    ? `${formatUnits(args.amount, 6)} USDC`
    : `${text(args.amount)} base units of ${receiver}`;
  return {
    title: 'Approve a payment',
    amount,
    rows: [
      { label: 'Action', value: 'Send a token transfer (ft_transfer_call)' },
      { label: 'Network', value: networkName(q.chain) },
      { label: 'Amount', value: amount },
      { label: 'To', value: text(args.receiver_id), mono: true },
      from,
      { label: 'Token', value: `${usdc ? 'USDC ' : ''}${receiver}`, mono: true },
      ...(msg.file_id ? [{ label: 'File', value: text(msg.file_id), mono: true }] : []),
      ...(msg.expires_at
        ? [{ label: 'Purchase valid until', value: secondsTime(msg.expires_at) }]
        : []),
      { label: 'Deposit', value: yocto(p.deposit) },
      { label: 'Gas limit', value: gas(p.gas) },
    ],
    message: { label: 'Transfer message', text: text(args.msg) },
    note: `${sends} It moves the amount above to ${text(args.receiver_id)} and attaches ${p.deposit === '1' ? '1 yoctoNEAR, which NEAR token transfers require' : `a deposit of ${yocto(p.deposit)}`}.`,
    terms: [],
    warnings: usdc
      ? []
      : ['The page does not recognise this token. The amount is in its base units.'],
  };
}

/** The summary of one signing request. Unknown operations are described as such, never guessed. */
export function describeRequest(q: SigningRequest): Summary {
  const s =
    q.operation === 'near.nep413'
      ? signedText(q, 'Sign a message (NEP-413)', [
          { label: 'Recipient', value: text(record(q.payload).recipient), mono: true },
        ])
      : q.operation === 'evm.personalSign'
        ? signedText(q, 'Sign a message (personal_sign)', [])
        : q.operation === 'evm.signTypedData'
          ? typedData(q)
          : q.operation === 'near.signTransaction'
            ? transaction(q)
            : {
                title: 'Unsupported request',
                rows: [{ label: 'Operation', value: text(q.operation) }],
                note: 'The page cannot sign this request.',
                terms: [],
                warnings: ['Unknown operation. Do not approve it.'],
              };
  const terms = describeTerms(q.terms, s.amount ? signedPrice(q) : undefined);
  return { ...s, terms: terms.rows, warnings: [...s.warnings, ...terms.warnings] };
}

/** The base-unit amount a payment request signs, for comparison with the CLI's terms. */
function signedPrice(q: SigningRequest): string | undefined {
  const p = record(q.payload);
  return q.operation === 'evm.signTypedData'
    ? text(record(p.message).value)
    : q.operation === 'near.signTransaction'
      ? text(record(p.args).amount)
      : undefined;
}
