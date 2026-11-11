import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { decodeSignedTransaction } from 'near-api-js';
import { verifyTypedData } from 'viem';
import { type NearMessage, type NearSignedMessage, verifyNearMessage } from '../near/nep413.js';
import { isFullAccessKey, NearError, type RpcReply, readOutcome, rpcReply } from '../near/rpc.js';
import { parseIdentity, verifyAuthorization } from '../settle-near/identity.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
export type Operation =
  | 'near.nep413'
  | 'near.signTransaction'
  | 'evm.personalSign'
  | 'evm.signTypedData';
export interface SigningRequest {
  version: 1;
  id: string;
  operation: Operation;
  chain: string;
  account: string;
  expiresAt: number;
  payload: unknown;
  terms?: unknown;
}
export type SigningResult = {
  signature?: string;
  account?: string;
  publicKey?: string;
  accountId?: string;
  signedTransaction?: string;
  txHash?: string;
};
export const json = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    typeof x === 'bigint' ? String(x) : x instanceof Uint8Array ? [...x] : x,
  );
export function signingRequest(
  operation: Operation,
  chain: string,
  account: string,
  payload: unknown,
  ttl = 120000,
): SigningRequest {
  return {
    version: 1,
    id: randomUUID(),
    operation,
    chain,
    account,
    expiresAt: Date.now() + ttl,
    payload: JSON.parse(json(payload)),
  };
}
/** Both transports use this verifier; no response is evidence merely because it was approved. */
export async function verifySigningResult(
  q: SigningRequest,
  r: SigningResult,
  nearRpc: string,
): Promise<void> {
  if (Date.now() >= q.expiresAt) throw new Error('signing request expired');
  if (q.operation.startsWith('evm.')) {
    const identity = parseIdentity({ kind: 'evm', id: q.account });
    if (!/^eip155:[1-9][0-9]*$/.test(q.chain) || typeof r.signature !== 'string')
      throw new Error('invalid EVM response');
    if (q.operation === 'evm.personalSign') {
      const p = q.payload as { message: string };
      if (
        typeof p.message !== 'string' ||
        !verifyAuthorization(identity, p.message, { kind: 'evm', sig: r.signature })
      )
        throw new Error('signature mismatch');
    } else {
      const p = q.payload as { domain?: { chainId?: number | string } };
      if (
        `eip155:${p.domain?.chainId}` !== q.chain ||
        !(await verifyTypedData({ ...p, address: identity.id, signature: r.signature } as never))
      )
        throw new Error('typed data signature or chain mismatch');
    }
    return;
  }
  if (!['near:mainnet', 'near:testnet', 'near:sandbox'].includes(q.chain))
    throw new Error('invalid NEAR chain');
  if (q.operation === 'near.nep413') {
    const p = q.payload as NearMessage;
    await verifyNearMessage(
      q.account,
      { ...p, nonce: Uint8Array.from(p.nonce) },
      r as NearSignedMessage,
      nearRpc,
    );
    return;
  }
  const p = q.payload as {
    receiverId: string;
    method: string;
    args: object;
    gas: string;
    deposit: string;
    transaction?: string;
  };
  if (r.signedTransaction) {
    if (!p.transaction) throw new Error('missing exact unsigned transaction');
    const signed = decodeSignedTransaction(base64.decode(r.signedTransaction));
    const tx = signed.transaction;
    const publicKey = tx.publicKey.toString();
    const fc = tx.actions[0]?.functionCall;
    const sameArgs = (a: unknown, b: unknown) => {
      const stable = (v: unknown): string =>
        v && typeof v === 'object'
          ? Array.isArray(v)
            ? `[${v.map(stable)}]`
            : `{${Object.keys(v)
                .sort()
                .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
                .join(',')}}`
          : JSON.stringify(v);
      return stable(a) === stable(b);
    };
    if (
      tx.receiverId !== p.receiverId ||
      tx.actions.length !== 1 ||
      !fc ||
      fc.methodName !== p.method ||
      String(fc.gas) !== p.gas ||
      String(fc.deposit) !== p.deposit ||
      !sameArgs(JSON.parse(new TextDecoder().decode(Uint8Array.from(fc.args))), p.args)
    )
      throw new Error('unsigned transaction action mismatch');
    if (
      base64.encode(tx.encode()) !== p.transaction ||
      tx.signerId !== q.account ||
      !publicKey.startsWith('ed25519:') ||
      !ed25519.verify(
        Uint8Array.from(signed.signature.ed25519Signature?.data ?? []),
        sha256(tx.encode()),
        base58.decode(publicKey.slice(8)),
        { zip215: false },
      ) ||
      !(await isFullAccessKey(nearRpc, q.account, publicKey))
    )
      throw new Error('signed transaction mismatch');
    return;
  }
  if (!r.txHash) throw new Error('missing transaction evidence');
  let reply: RpcReply;
  try {
    // Verify one independently fetched result, avoiding a second inconsistent RPC snapshot.
    reply = await rpcReply(nearRpc, 'tx', {
      tx_hash: r.txHash,
      sender_account_id: q.account,
      wait_until: 'FINAL',
    });
  } catch (error) {
    if (error instanceof NearError && error.code === 'transport')
      throw new TransactionUncertain(r.txHash);
    throw error;
  }
  const t = reply.result as {
    final_execution_status?: string;
    transaction?: { actions?: { FunctionCall?: { gas?: string | number; deposit?: string } }[] };
  };
  if (reply.error) {
    if (
      ['UNKNOWN_TRANSACTION', 'TIMEOUT_ERROR', 'INTERNAL_ERROR'].includes(
        reply.error.cause?.name ?? reply.error.name ?? '',
      )
    )
      throw new TransactionUncertain(r.txHash);
    throw new Error('transaction RPC rejected the evidence');
  }
  if (t?.final_execution_status !== 'FINAL') throw new TransactionUncertain(r.txHash);
  const fc = t.transaction?.actions?.[0]?.FunctionCall;
  if (String(fc?.gas) !== p.gas || fc?.deposit !== p.deposit)
    throw new Error('transaction gas/deposit mismatch');
  // Semantic rejections must never become nearSubmission evidence. readOutcome also checks
  // hash, signer, receiver, method, args and execution status on this same finalized response.
  const result = readOutcome(t, p.receiverId, {
    txHash: r.txHash,
    signer: q.account,
    method: p.method,
    args: p.args,
  });
  if (result.state === 'pending') throw new TransactionUncertain(r.txHash);
  if (!['done', 'released'].includes(result.state)) throw new Error('transaction did not succeed');
}
export function remoteSigner(o: {
  url: string;
  credential: () => Promise<string>;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}) {
  const u = new URL(o.url);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== '/' && u.pathname !== '')
  )
    throw new TypeError('signer must be an HTTPS origin without credentials');
  const fetcher = o.fetch ?? fetch;
  return async (
    q: SigningRequest,
    verify: (r: SigningResult) => Promise<void>,
  ): Promise<SigningResult> => {
    const credential = await o.credential();
    if (!credential || /[\r\n]/.test(credential)) throw new Error('signer credential required');
    const call = async (path: string, body?: unknown) => {
      if (Date.now() >= q.expiresAt) throw new Error('signing request expired');
      const res = await fetcher(new URL(path, u).href, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(20000, q.expiresAt - Date.now()))),
        ...(body === undefined ? {} : { body: json(body) }),
      });
      if (!res.ok) throw new Error('signer unavailable');
      return res.json();
    };
    const c = await call('/v1/capabilities');
    if (
      c.version !== 1 ||
      c.account !== q.account ||
      c.chain !== q.chain ||
      !Array.isArray(c.operations) ||
      !c.operations.includes(q.operation)
    )
      throw new Error('signer capability mismatch');
    let r: { version?: number; id?: string; status?: string; result?: SigningResult };
    // Only transport failures retry creation. Every attempt uses the same immutable request/id.
    const exact = JSON.parse(json(q)) as SigningRequest;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await call('/v1/requests', exact);
        break;
      } catch (error) {
        if (
          !(
            error instanceof TypeError ||
            (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          ) ||
          attempt >= 2 ||
          Date.now() >= q.expiresAt
        )
          throw error;
        await (o.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1000);
      }
    }
    for (;;) {
      if (r.version !== 1 || r.id !== q.id) throw new Error('signer response mismatch');
      if (r.status === 'rejected') throw new Error('signer rejected request');
      if (r.status === 'approved') {
        if (!r.result) throw new Error('missing signer result');
        await verify(r.result);
        return r.result;
      }
      if (r.status !== 'pending') throw new Error('invalid signer status');
      await (o.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1000);
      r = await call(`/v1/requests/${encodeURIComponent(q.id)}`);
    }
  };
}
