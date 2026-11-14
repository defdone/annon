/** Relay request canonicalization, contract arguments and operation identity. */

import { registerText } from '../near/texts.js';
import type { EvmLog } from '../pay/base.js';
import { bytes, exactKeys, uint } from '../settle-near/codec.js';
import { identityJson, verifyAuthorization } from '../settle-near/identity.js';
import { buyerKey, parsePurchaseMessage } from '../settle-near/purchase.js';
import { type SettlementAssets, termsHash } from '../settle-near/terms.js';
import { fail, type RelayPolicy, type RelayRequest } from './relay-types.js';
import { parseReservation } from './reservation.js';

export function canonicalRequest(input: unknown, assets?: SettlementAssets): RelayRequest {
  try {
    const r = structuredClone(input) as RelayRequest;
    if (!r || typeof r !== 'object') throw new Error('expected request');
    exactKeys(r, [
      'method',
      'args',
      ...('auth' in r ? ['auth'] : []),
      ...('baseSplit' in r ? ['baseSplit'] : []),
      ...('hostingReservation' in r ? ['hostingReservation'] : []),
    ]);
    if ('hostingReservation' in r) {
      if (r.method !== 'register') throw new Error('invalid hosting reservation');
      r.hostingReservation = parseReservation(r.hostingReservation);
    }
    if ('baseSplit' in r) {
      if (r.method !== 'register' || !r.baseSplit) throw new Error('invalid split provenance');
      exactKeys(r.baseSplit, ['kind', 'salt']);
      if (!['push', 'pull'].includes(r.baseSplit.kind)) throw new Error('invalid split kind');
      bytes(r.baseSplit.salt, 32);
    }
    if ('auth' in r) {
      if (
        !['register', 'reopen', 'reopen_seller', 'stop_sales', 'fund_file_storage'].includes(
          r.method,
        )
      )
        throw new Error('unexpected authorization');
      exactKeys(r.auth, ['kind', 'sig']);
      if (!['evm', 'solana'].includes(r.auth.kind)) throw new Error('invalid auth kind');
      bytes(r.auth.sig, r.auth.kind === 'evm' ? 65 : 64);
    }
    const a = r.args;
    switch (r.method) {
      case 'fund_file_storage':
        exactKeys(a, ['file_id', 'amount', 'nonce', 'deadline']);
        bytes(r.args.nonce, 32);
        bytes(r.args.file_id, 32);
        if (uint(r.args.amount, 128) <= 0n) throw new Error('positive topup required');
        break;
      case 'register':
        exactKeys(a, ['terms', 'seller_key', 'deadline']);
        termsHash(r.args.terms, assets);
        buyerKey(r.args.seller_key);
        break;
      case 'reopen':
        exactKeys(a, ['purchase_id', 'fresh_key', 'nonce', 'deadline']);
        bytes(r.args.purchase_id, 32);
        buyerKey(r.args.fresh_key);
        bytes(r.args.nonce, 32);
        break;
      case 'reopen_seller':
      case 'stop_sales':
        exactKeys(a, ['file_id', 'key', 'deadline']);
        bytes(r.args.file_id, 32);
        if (r.method === 'reopen_seller') buyerKey(r.args.key ?? '');
        else if (r.args.key !== null) throw new Error('stop key must be null');
        break;
      case 'claim_key':
        exactKeys(a, ['purchase_id', ...('grant' in a ? ['grant'] : [])]);
        bytes(r.args.purchase_id, 32);
        if (
          r.args.grant !== undefined &&
          (!Number.isInteger(r.args.grant) || r.args.grant < 0 || r.args.grant > 0xffffffff)
        )
          throw new Error('invalid grant');
        r.args.grant = r.args.grant ?? 0;
        break;
      case 'unlock':
        exactKeys(a, ['purchase', 'logs', 'header']);
        if (parsePurchaseMessage(r.args.purchase, assets).route !== 'base-usdc')
          throw new Error('not a Base purchase');
        if (
          !Array.isArray(r.args.logs) ||
          r.args.logs.length !== 2 ||
          (r.args.header !== null && !/^0x([0-9a-f]{2})+$/.test(r.args.header))
        )
          throw new Error('invalid logs/header');
        r.args.logs = r.args.logs.map((input) => {
          const fields = [
            'address',
            'block_hash',
            'block_number',
            'data',
            'log_index',
            'removed',
            'topics',
            'transaction_hash',
            'transaction_index',
          ] as const;
          exactKeys(input, [...fields]);
          for (const key of ['address', 'block_hash', 'transaction_hash'] as const)
            bytes(`0x${input[key]}`, key === 'address' ? 20 : 32);
          if (!Array.isArray(input.topics) || input.topics.length !== 3)
            throw new Error('invalid log topics');
          for (const topic of input.topics) bytes(`0x${topic}`, 32);
          for (const key of ['block_number', 'log_index', 'transaction_index'] as const)
            if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
              throw new Error('invalid log index');
          if (
            input.removed !== false ||
            typeof input.data !== 'string' ||
            input.data.length > 256 ||
            !/^0x(?:[0-9a-f]{2})*$/.test(input.data)
          )
            throw new Error('invalid log data');
          return Object.fromEntries(fields.map((k) => [k, input[k]])) as unknown as EvmLog;
        });
        break;
      default:
        throw new Error('unknown method');
    }
    if ('deadline' in a) {
      if (!Number.isSafeInteger(a.deadline)) throw new Error('invalid deadline');
      uint(String(a.deadline), 64);
    }
    if (
      ['register', 'reopen', 'stop_sales', 'reopen_seller', 'fund_file_storage'].includes(
        r.method,
      ) &&
      !('auth' in r)
    )
      throw new Error('auth required; NEAR identities call directly');
    return r;
  } catch (e) {
    return fail('bad_request', (e as Error).message);
  }
}

/** Contract wire shape: unlock and identity calls wrap args; claim_key is flat. */
export const contractArgs = (r: RelayRequest): object =>
  r.method === 'fund_file_storage'
    ? { file_id: r.args.file_id, amount: r.args.amount }
    : 'auth' in r
      ? { args: r.args, auth: r.auth }
      : r.method === 'unlock'
        ? { args: r.args }
        : r.args;

/**
 * What makes two requests the same operation. Only a party that could make the request succeed
 * can hold it: wallet signatures are checked against their authoritative identities before
 * anything is held, and an unlock
 * includes the buyer's key, which only the buyer knows before it is sent.
 */
const identity = (r: RelayRequest) => {
  if (r.method === 'unlock') return `unlock:${JSON.parse(r.args.purchase).purchase.purchase_id}`;
  if (r.method === 'claim_key') return `claim:${r.args.purchase_id}:${r.args.grant ?? 0}`;
  if (r.method === 'reopen')
    return `reopen:${r.args.purchase_id}:${r.args.fresh_key}:${r.args.nonce}`;
  if (r.method === 'register') return `register:${r.args.terms.file_id}`;
  if (r.method === 'fund_file_storage')
    return `fund_file_storage:${r.args.file_id}:${r.args.nonce}`;
  return `${r.method}:${r.args.file_id}:${r.args.key ?? ''}`;
};

const signedByItsWallet = (r: RelayRequest, contract: string, assets?: SettlementAssets) => {
  if (
    r.method === 'register' &&
    !verifyAuthorization(r.args.terms.seller, registerText(contract, r.args, assets), r.auth)
  )
    fail('bad_signature');
};

const quota = (r: RelayRequest, p: RelayPolicy): [string, number] | null =>
  r.method === 'register'
    ? [`register:${identityJson(r.args.terms.seller)}`, p.registrationsPerSeller ?? 20]
    : r.method === 'claim_key'
      ? [`claim:${r.args.purchase_id}:${r.args.grant ?? 0}`, p.claimsPerGrant ?? 3]
      : r.method === 'reopen'
        ? [`reopen:${r.args.purchase_id}`, p.reopensPerWalletFile ?? 10]
        : null;

const requestBinding = (r: RelayRequest) => {
  if (r.method !== 'register') return r;
  const { hostingReservation: _reservation, ...binding } = r;
  return binding;
};

export { identity, quota, requestBinding, signedByItsWallet };
