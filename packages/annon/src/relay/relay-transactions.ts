/** NEAR transaction signing, submission retries and RPC evidence helpers. */

import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, actions, encodeTransaction, JsonRpcProvider } from 'near-api-js';
import { RPC_TIMEOUT_MS, type RpcReply, rpcReply } from '../near/rpc.js';
import { sleep } from '../net/retry.js';
import { accounts, IN_BLOCK } from './relay.js';
import { fail, type RelayResult, type Sender } from './relay-types.js';

/** Gas for every call: `unlock` needs 150 Tgas, MPC's callbacks use the rest; unused gas returns. */
const GAS = 300_000_000_000_000n;

/** How many more tries after the first send: the same bytes again, or after PENDING a lookup. */
const RESENDS = 2;

/** The first wait before trying again when NEAR says "later" or "pending"; it grows each try. */
const RETRY_WAIT = 1_000;

/**
 * The provider near-api-js signs with: it reads the key's nonce and a recent block. Every reply
 * that sends a transaction or looks one up goes through `rpcReply` instead (its id checked, one
 * fetch, aborted at the deadline).
 */
// Note: the timer ends the wait, not the request (near-api-js 7.4 takes no AbortSignal).
function signingProvider(url: string) {
  const p = new JsonRpcProvider({ url });
  const send = p.sendJsonRpc.bind(p);
  p.sendJsonRpc = ((method: string, params: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new Error(`NEAR RPC ${method} timed out`)), RPC_TIMEOUT_MS);
    });
    return Promise.race([send(method as never, params as never), late]).finally(() =>
      clearTimeout(timer),
    );
  }) as typeof p.sendJsonRpc;
  return p;
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

const inBlock = (result: unknown) => {
  const s = (result as { final_execution_status?: unknown } | null | undefined)
    ?.final_execution_status;
  return typeof s === 'string' && IN_BLOCK.has(s);
};

/**
 * What NEAR's error guide (docs.near.org/api/rpc/transactions#error-handling) says to do after an
 * error: send the same bytes again now or `later`, only look it up (`pending`), ask a node that
 * tracks its shard (`elsewhere`), or `stop`: the same node would give the same answer.
 */
function advice(e: NonNullable<RpcReply['error']>) {
  const refused = (e.data as { TxExecutionError?: { InvalidTxError?: unknown } } | undefined)
    ?.TxExecutionError?.InvalidTxError;
  // Nodes before nearcore 2.14 send no `cause.info`: the same as NOT_OBSERVED.
  const timeout =
    e.cause?.name === 'TIMEOUT_ERROR'
      ? ((e.cause.info as { cause?: string } | undefined)?.cause ?? 'NOT_OBSERVED')
      : undefined;
  if (e.cause?.name === 'DOES_NOT_TRACK_SHARD' || timeout === 'DOES_NOT_TRACK_SHARD')
    return 'elsewhere';
  if (timeout === 'PENDING') return 'pending';
  if (timeout === 'NOT_OBSERVED') return 'again';
  const busy = isObject(refused) && ('ShardCongested' in refused || 'ShardStuck' in refused);
  if (busy || e.name === 'INTERNAL_ERROR' || timeout === 'ERROR') return 'later';
  return 'stop';
}

/** NEAR's own words for an error: the transaction's refusal, or the whole error. */
function describe(e: NonNullable<RpcReply['error']>) {
  const { name, cause, data, message } = e;
  const refused = (data as { TxExecutionError?: { InvalidTxError?: unknown } } | undefined)
    ?.TxExecutionError?.InvalidTxError;
  return JSON.stringify(refused ?? { name, cause, data, message });
}

/** Ask for FINAL evidence by hash; a lost reply never proves rejection. */
const lookUp = (url: string, tx: string, accountId: string) =>
  rpcReply(url, 'tx', { tx_hash: tx, sender_account_id: accountId, wait_until: 'FINAL' }).catch(
    () => null,
  );

const senderKey = (o: { nearRpc: string; sender: Sender }) =>
  `${o.nearRpc}|${o.sender.accountId}|${o.sender.key}`;

/** Signs one function call, no deposit, with the sender's key (one account per key, so near-api-js
 * numbers its nonces locally across calls). */
async function sign(
  o: { nearRpc: string; contractId: string; sender: Sender },
  key: string,
  method: string,
  args: object,
  gas = GAS,
) {
  let account = accounts.get(key);
  if (!account) {
    account = new Account(
      o.sender.accountId,
      signingProvider(o.nearRpc),
      o.sender.key as `ed25519:${string}`,
    );
    accounts.set(key, account);
  }
  const tx = await account
    .createSignedTransaction({
      receiverId: o.contractId,
      actions: [actions.functionCall(method, args, gas, 0n)],
    })
    .catch(() => fail('transport', 'NEAR signing is unavailable.'));
  return {
    txHash: base58.encode(sha256(tx.transaction.encode())),
    ...(tx.transaction.blockHash?.length === 32
      ? { referenceHash: base58.encode(Uint8Array.from(tx.transaction.blockHash)) }
      : {}),
    signed: base64.encode(encodeTransaction(tx)),
  };
}

/**
 * Sends signed bytes; after a lost or unclear answer, looks the transaction up and sends the same
 * bytes again (same hash). Only definite validation refusals are reported as not sent.
 */
async function send(
  o: { nearRpc: string; sender: Sender },
  key: string,
  txHash: string,
  signed: string,
  keeper = false,
  unknownFinal = false,
): Promise<RelayResult> {
  const unclear = (reason: string): RelayResult => ({ txHash, uncertain: true, reason });
  let reason = 'no clear answer from NEAR';
  // After NEAR said it has the transaction (a PENDING timeout), the relayer only looks it up.
  let look = false;
  let ambiguous = false;
  try {
    for (let attempt = 0; attempt <= RESENDS; attempt++) {
      const reply = look
        ? undefined
        : await rpcReply(o.nearRpc, 'send_tx', {
            signed_tx_base64: signed,
            wait_until: 'INCLUDED',
          }).catch(() => null);
      if (reply && !reply.error && inBlock(reply.result)) return { txHash };
      const legacy = reply?.error?.data as
        | { TxExecutionError?: { InvalidTxError?: unknown } }
        | undefined;
      const info = reply?.error?.cause?.info as { InvalidTxError?: unknown } | undefined;
      const refused = legacy?.TxExecutionError?.InvalidTxError ?? info?.InvalidTxError;
      const variant =
        typeof refused === 'string'
          ? refused
          : isObject(refused)
            ? Object.keys(refused)[0]
            : undefined;
      // InvalidNonce can mean these very bytes already landed. Unknown variants are ambiguous too.
      const definite = new Set([
        'NotEnoughBalance',
        'NotEnoughAllowance',
        'InvalidAccessKeyError',
        'InvalidSignerId',
        'SignerDoesNotExist',
        'InvalidReceiverId',
        'InvalidSignature',
        'CostOverflow',
        'InvalidChain',
        'Expired',
        'ActionsValidation',
        'TransactionSizeExceeded',
      ]);
      if (unknownFinal) definite.add('InvalidNonce');
      if (variant !== undefined && definite.has(variant)) {
        accounts.delete(key);
        if (ambiguous) {
          const status = await lookUp(o.nearRpc, txHash, o.sender.accountId);
          if (status && !status.error && inBlock(status.result)) return { txHash };
          return unclear('an earlier submission may have landed before this validation refusal');
        }
        // Only the variant name is public; RPC data may echo arbitrary transaction fields.
        return {
          txHash,
          rejected: true,
          reason: variant && /^[A-Za-z]+$/.test(variant) ? variant : 'InvalidTxError',
        };
      }
      ambiguous = true;
      // The chain is past the nonces given out here: later operations read it afresh, whether or
      // not this one landed.
      if (variant === 'InvalidNonce') accounts.delete(key);
      const status = await lookUp(o.nearRpc, txHash, o.sender.accountId);
      if (status && !status.error && inBlock(status.result)) return { txHash };
      // A refusal doesn't prove nothing landed (a node may accept a transaction and refuse it on
      // a later check in the same call), so it is unclear too. Errors of the send and of the
      // lookup are taken as NEAR's guide says; an unknown transaction is only "not seen yet".
      let later = false;
      for (const [what, e] of [
        ['send', reply?.error],
        [
          'lookup',
          status?.error?.cause?.name === 'UNKNOWN_TRANSACTION' ? undefined : status?.error,
        ],
      ] as const) {
        if (!e) continue;
        const next = advice(e);
        reason = `NEAR answered the ${what}: ${describe(e)}`;
        if (next === 'elsewhere') return unclear(`${reason}; ask a NEAR RPC that tracks its shard`);
        if (what === 'send' && (next === 'stop' || (keeper && next !== 'pending')))
          return unclear(reason);
        if (next === 'pending') look = true;
        if (next === 'later') later = true;
      }
      // Note: sends wait in line meanwhile, at most 3 s per transaction.
      if (attempt < RESENDS && (later || look)) await sleep(RETRY_WAIT * (attempt + 1));
    }
    return unclear(reason);
  } catch {
    return unclear('NEAR submission is unresolved.');
  }
}

export { lookUp, send, senderKey, sign };
