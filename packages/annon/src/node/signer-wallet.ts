import { readFile } from 'node:fs/promises';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, actions, PublicKey } from 'near-api-js';
import { signNearUpload } from '../browser/wallets.js';
import { proveNearControl } from '../near/nep413.js';
import { rpcReply, txOutcome } from '../near/rpc.js';
import type { TypedData } from '../pay/eip3009.js';
import { parseIdentity } from '../settle-near/identity.js';
import { parsePurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { nearSelectorWallet } from '../wallet/wallet.js';
import { type SignerConfig, validateSigner } from './agent.js';
import type { BrowserSession } from './browser-login.js';
import type { Input } from './cli.js';
import type { Config } from './config.js';
import { AdapterError } from './errors.js';
import { decodeKeychain, type Keychain } from './keychain.js';
import {
  remoteSigner,
  type SigningRequest,
  type SigningResult,
  signingRequest,
  verifySigningResult,
} from './signing.js';
import { type Environment, type LocalWallet, loadWallet } from './wallets.js';
export function assertSignerInput(o: Partial<Input>): void {
  if (o.evmKeyFile !== undefined || o.nearKeyFile !== undefined || o.solanaKeyFile !== undefined)
    throw new AdapterError(
      'signer_init_only',
      'Key-file overrides are refused with a configured signer.',
      2,
    );
}
export async function configuredWallet(
  s: SignerConfig,
  c: Config,
  o: Input,
  env: Environment,
  keychain: Keychain,
  browser: () => Promise<BrowserSession>,
  terms: () => unknown,
): Promise<LocalWallet> {
  assertSignerInput(o);
  validateSigner(s);
  if (s.mode === 'file' || s.mode === 'env' || s.mode === 'keychain') {
    const key =
      s.mode === 'file'
        ? (await readFile(s.file, 'utf8')).trim()
        : s.mode === 'env'
          ? env[s.name]
          : decodeKeychain(await keychain.read(s.entry));
    const keyEnv =
      s.kind === 'evm'
        ? 'ANNON_EVM_PRIVATE_KEY'
        : s.kind === 'near'
          ? 'ANNON_NEAR_CREDENTIALS'
          : 'ANNON_SOLANA_KEYPAIR';
    return loadWallet(
      {
        ...o,
        wallet: s.kind,
        ...(s.identity ? { recovery: `${s.identity.kind}:${s.identity.id}` } : {}),
      },
      { [keyEnv]: key },
      c.nearRpc,
      keychain,
    );
  }
  const id = parseIdentity(s.identity);
  const session = s.mode === 'browser' ? await browser() : undefined;
  const transport =
    s.mode === 'remote'
      ? remoteSigner({
          url: s.url,
          credential: async () =>
            'env' in s.credential
              ? (env[s.credential.env] ?? '')
              : await keychain.read(s.credential.keychain),
        })
      : undefined;
  const sign = async (operation: SigningRequest['operation'], payload: unknown) => {
    const q = signingRequest(
      operation,
      id.kind === 'evm' ? 'eip155:8453' : c.network,
      id.id,
      payload,
    );
    q.terms = terms();
    const verify = (r: SigningResult) => verifySigningResult(q, r, c.nearRpc);
    if (transport) return transport(q, verify);
    if (!session) throw new Error('missing browser session');
    return session.request<SigningResult>(q, verify);
  };
  if (id.kind === 'evm')
    return {
      identity: id,
      address: id.id,
      authorize: async (message) => ({
        kind: 'evm',
        sig: (await sign('evm.personalSign', { message })).signature as string,
      }),
      signTypedData: async (data: TypedData) =>
        (await sign('evm.signTypedData', data)).signature as string,
    } as LocalWallet;
  if (id.kind !== 'near') throw new Error('browser/remote Solana signing is not supported');
  const signMessage = async (p: unknown) =>
    (await sign('near.nep413', p)) as { accountId: string; publicKey: string; signature: string };
  const wallet = nearSelectorWallet(
    {
      getAccounts: async () => [{ accountId: id.id }],
      signAndSendTransaction: async (tx) => {
        const fc = tx.actions[0]?.params;
        if (!fc) throw new Error('missing action');
        let payload: Record<string, unknown> = {
          receiverId: tx.receiverId,
          method: fc.methodName,
          args: fc.args,
          gas: fc.gas,
          deposit: fc.deposit,
        };
        if (s.mode === 'remote') {
          if (!s.publicKey)
            throw new Error('remote NEAR transactions require the public key in config');
          // Transport exception near_api_remote_signer: Account builds the unsigned transaction.
          // Its provider uses the third-party Node fetch transport for nonce and block lookup.
          const unsigned = await new Account(id.id, c.nearRpc).createTransaction({
            receiverId: tx.receiverId,
            publicKey: PublicKey.fromString(s.publicKey),
            actions: [
              actions.functionCall(fc.methodName, fc.args, BigInt(fc.gas), BigInt(fc.deposit)),
            ],
          });
          payload = { ...payload, transaction: base64.encode(unsigned.encode()) };
        }
        const msg = (fc.args as { msg?: string }).msg;
        const purchase =
          fc.methodName === 'ft_transfer_call' && msg
            ? purchaseId(parsePurchaseMessage(msg))
            : undefined;
        let knownHash: string | undefined;
        try {
          const result = await sign('near.signTransaction', payload);
          let hash = result.txHash;
          if (result.signedTransaction) {
            const { decodeSignedTransaction } = await import('near-api-js');
            hash = base58.encode(
              sha256(
                decodeSignedTransaction(
                  base64.decode(result.signedTransaction),
                ).transaction.encode(),
              ),
            );
            knownHash = hash;
            const sent = await rpcReply(c.nearRpc, 'send_tx', {
              signed_tx_base64: result.signedTransaction,
              wait_until: 'FINAL',
            });
            if (sent.error) throw new TransactionUncertain(hash, purchase);
            await verifySigningResult(
              signingRequest('near.signTransaction', c.network, id.id, payload),
              { txHash: hash },
              c.nearRpc,
            );
          }
          if (!hash) throw new Error('missing transaction hash');
          knownHash = hash;
          const out = await txOutcome(c.nearRpc, hash, id.id, tx.receiverId, 'FINAL', {
            method: fc.methodName,
            args: fc.args,
          });
          if (out.state === 'released') return out.answer;
          if (out.state === 'done') return out.value;
          throw new TransactionUncertain(hash, purchase);
        } catch (error) {
          if (error instanceof TransactionUncertain)
            throw new TransactionUncertain(error.txHash, purchase);
          if (knownHash) throw new TransactionUncertain(knownHash, purchase);
          throw error;
        }
      },
    },
    id.id,
    (text, context) =>
      proveNearControl(
        id.id,
        text,
        { ...context, ...(session ? { callbackUrl: new URL('/callback', session.url).href } : {}) },
        signMessage,
      ),
  );
  return {
    ...wallet,
    signUpload: (intent) =>
      signNearUpload(
        { getAccounts: async () => [{ accountId: id.id }], signMessage },
        intent,
        c.nearRpc,
      ),
  };
}
