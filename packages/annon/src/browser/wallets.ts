/** Page-owned providers adapted to Annon wallets. No wallet packages or browser globals. */
import { base58, base64 } from '@scure/base';
import {
  parseUploadIntent,
  type UploadAuth,
  type UploadIntent,
  uploadText,
} from '../download/upload.js';
import { AnnonError, present } from '../errors.js';
import {
  type NearMessage,
  type NearSignedMessage,
  proveNearControl,
  verifyNearMessage,
} from '../near/nep413.js';
import { BASE_CHAIN_ID, digest, signer, type TypedData } from '../pay/eip3009.js';
import { bytes, hex } from '../settle-near/codec.js';
import { type Authorization, parseIdentity, verifyAuthorization } from '../settle-near/identity.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import {
  type EvmWallet,
  evmWallet,
  type IdentityWallet,
  type NearWallet,
  nearSelectorWallet,
} from '../wallet/wallet.js';

export type BrowserWalletErrorCode =
  | 'rejected'
  | 'wrong_chain'
  | 'wrong_identity'
  | 'invalid_signature'
  | 'missing_method'
  | 'invalid_response'
  | 'wallet_error';
export class BrowserWalletError extends AnnonError {
  constructor(
    readonly code: BrowserWalletErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'BrowserWalletError';
  }
}
function fail(code: BrowserWalletErrorCode, message: string): never {
  throw new BrowserWalletError(code, message);
}
/** Wallets differ in rejection shape; unwrap transport errors without exposing their text to a page. */
async function checked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrowserWalletError || error instanceof TransactionUncertain) throw error;
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      const e = cause as { code?: unknown; message?: unknown; cause?: unknown };
      if (e.code === 4001 || e.code === 'ACTION_REJECTED')
        throw new BrowserWalletError('rejected', 'The wallet request was rejected.', {
          cause: error,
        });
      if (e.code === 4901 || e.code === 4902)
        throw new BrowserWalletError('wrong_chain', 'Select Base in the wallet.', { cause: error });
      if (e.code === -32601 || e.code === 4200)
        throw new BrowserWalletError('missing_method', 'The wallet does not support this method.', {
          cause: error,
        });
      cause = e.cause;
    }
    throw new BrowserWalletError('wallet_error', 'The wallet request failed.', { cause: error });
  }
}
export interface InjectedEvmProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}
/** Checks Base before signing and after the result. Switching always asks the page's provider. */
export function browserEvmWallet(provider: InjectedEvmProvider, address: string): EvmWallet {
  const identity = parseIdentity({ kind: 'evm', id: address });
  const request: InjectedEvmProvider['request'] = (q) =>
    checked(async () => {
      if (typeof provider.request !== 'function')
        fail('missing_method', 'EIP-1193 request is unavailable.');
      const result = await provider.request(q);
      if (
        q.method === 'eth_accounts' &&
        (!Array.isArray(result) ||
          !result.some((a) => typeof a === 'string' && a.toLowerCase() === identity.id))
      )
        fail('wrong_identity', 'The wallet does not control the selected identity.');
      return result;
    });
  const underlying = evmWallet({ request }, identity.id);
  const chain = async () => {
    const id = await request({ method: 'eth_chainId' });
    try {
      if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id)) return false;
      return BigInt(id) === BigInt(BASE_CHAIN_ID);
    } catch {
      return false;
    }
  };
  const selected = async (switchChain: boolean) => {
    if (!(await chain())) {
      if (switchChain)
        await request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
      if (!switchChain || !(await chain())) fail('wrong_chain', 'Select Base in the wallet.');
    }
    await request({ method: 'eth_accounts' });
  };
  return {
    identity,
    address: identity.id,
    authorize: (text) =>
      checked(async () => {
        // personal_sign does not depend on the chain: recovery works on any network the wallet is on.
        await request({ method: 'eth_accounts' });
        // Share the EIP-191 signing path used by browser login.
        let auth: Authorization | undefined;
        try {
          auth = await underlying.authorize(text);
        } catch (error) {
          if (error instanceof AnnonError && error.code === 'invalid_signature')
            fail('invalid_signature', 'The wallet returned an invalid recovery signature.');
          throw error;
        }
        if (!verifyAuthorization(identity, text, auth))
          fail('invalid_signature', 'The wallet returned an invalid recovery signature.');
        await request({ method: 'eth_accounts' });
        return auth;
      }),
    signTypedData: (data: TypedData) =>
      checked(async () => {
        if (data.domain.chainId !== BASE_CHAIN_ID)
          fail('wrong_chain', 'Payment authorization must name Base.');
        if (data.message.from.toLowerCase() !== identity.id)
          fail('wrong_identity', 'Payment authorization names another identity.');
        await selected(true);
        const sig = await underlying.signTypedData(data);
        if (
          typeof sig !== 'string' ||
          signer(digest(data.domain.verifyingContract, data.message), sig) !== identity.id
        )
          fail('invalid_signature', 'The wallet returned an invalid payment signature.');
        await selected(false);
        return sig;
      }),
  };
}
export type InjectedSolanaKey = string | Uint8Array | { toBytes(): Uint8Array };
export interface InjectedSolanaProvider {
  publicKey?: InjectedSolanaKey | null;
  signMessage?: (
    message: Uint8Array,
  ) => Promise<Uint8Array | { signature: Uint8Array; publicKey?: InjectedSolanaKey }>;
}
function solanaId(key: InjectedSolanaKey | undefined | null): string {
  try {
    if (!key) return fail('wrong_identity', 'No Solana identity is selected.');
    return parseIdentity({
      kind: 'solana',
      id:
        typeof key === 'string'
          ? key
          : base58.encode(key instanceof Uint8Array ? key : key.toBytes()),
    }).id;
  } catch {
    return fail('wrong_identity', 'The wallet returned another Solana identity.');
  }
}
export function browserSolanaWallet(
  provider: InjectedSolanaProvider,
  address: string,
): IdentityWallet {
  const identity = parseIdentity({ kind: 'solana', id: address });
  const selected = () => {
    if (solanaId(provider.publicKey) !== identity.id)
      fail('wrong_identity', 'Select the requested Solana identity.');
  };
  return {
    identity,
    authorize: (text) =>
      checked(async () => {
        selected();
        const signMessage = provider.signMessage?.bind(provider);
        if (typeof signMessage !== 'function')
          fail('missing_method', 'Solana signMessage is unavailable.');
        const result = await signMessage(new TextEncoder().encode(text));
        const signature = result instanceof Uint8Array ? result : result?.signature;
        if (
          !(result instanceof Uint8Array) &&
          result?.publicKey &&
          solanaId(result.publicKey) !== identity.id
        )
          fail('wrong_identity', 'The signature names another Solana identity.');
        if (!(signature instanceof Uint8Array) || signature.length !== 64)
          fail('invalid_signature', 'The wallet returned an invalid Solana signature.');
        const auth: Authorization = { kind: 'solana', sig: hex(signature) };
        if (!verifyAuthorization(identity, text, auth))
          fail('invalid_signature', 'The wallet did not sign the exact recovery text.');
        selected();
        return auth;
      }),
  };
}
/** Selector v10 transaction shape, also used by the browser login transport. */
export interface BrowserNearTransaction {
  signerId: string;
  receiverId: string;
  actions: {
    functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
  }[];
}
export interface BrowserNearProvider {
  getAccounts?: () => Promise<readonly { accountId: string }[]>;
  signMessage?: (payload: NearMessage) => Promise<NearSignedMessage | undefined>;
  signAndSendTransaction?: (transaction: BrowserNearTransaction) => Promise<unknown>;
}
export function browserNearWallet(
  provider: BrowserNearProvider,
  accountId: string,
): NearWallet & Required<Pick<NearWallet, 'proveControl'>> {
  const identity = parseIdentity({ kind: 'near', id: accountId });
  const selected = async () => {
    if (typeof provider.getAccounts !== 'function')
      fail('missing_method', 'NEAR getAccounts is unavailable.');
    const accounts = await provider.getAccounts();
    if (!Array.isArray(accounts) || !accounts.some((a) => a?.accountId === identity.id))
      fail('wrong_identity', 'Select the requested NEAR identity.');
    return accounts;
  };
  const underlying = nearSelectorWallet(
    {
      getAccounts: selected,
      signAndSendTransaction: async (tx) => {
        if (typeof provider.signAndSendTransaction !== 'function')
          fail('missing_method', 'NEAR transaction signing is unavailable.');
        const result = await provider.signAndSendTransaction({
          signerId: tx.signerId,
          receiverId: tx.receiverId,
          actions: tx.actions.map(({ params }) => ({
            functionCall: {
              methodName: params.methodName,
              args: new TextEncoder().encode(JSON.stringify(params.args)),
              gas: BigInt(params.gas),
              deposit: BigInt(params.deposit),
            },
          })),
        });
        if (result && typeof result === 'object' && 'transaction' in result) {
          const transaction = result.transaction as { signer_id?: unknown; hash?: string } | null;
          if (transaction?.signer_id !== identity.id) {
            if (transaction?.hash) throw new TransactionUncertain(transaction.hash);
            fail('wrong_identity', 'The transaction names another NEAR identity.');
          }
        } else fail('invalid_response', 'The wallet returned no NEAR transaction.');
        return result;
      },
    },
    identity.id,
  );
  return {
    identity,
    authorize: (text) => checked(() => underlying.authorize(text)),
    call: (call) =>
      checked(async () => {
        const value = await underlying.call(call);
        try {
          await selected();
        } catch {
          const tx = (value as { transaction: { hash: string } }).transaction;
          throw new TransactionUncertain(tx.hash);
        }
        return value;
      }),
    transferPurchase: (message, assets) =>
      checked(() => underlying.transferPurchase(message, assets)),
    proveControl: (text, context) =>
      checked(async () => {
        await selected();
        const signMessage = provider.signMessage?.bind(provider);
        if (typeof signMessage !== 'function')
          fail('missing_method', 'NEAR recovery requires NEP-413 signMessage.');
        try {
          await proveNearControl(identity.id, text, context, async (p) => {
            const result = await signMessage(p);
            if (!result) fail('invalid_response', 'The wallet returned no NEP-413 signature.');
            if (result.accountId !== identity.id)
              fail('wrong_identity', 'The signature names another NEAR identity.');
            try {
              if (
                typeof result.publicKey !== 'string' ||
                !result.publicKey.startsWith('ed25519:') ||
                base58.decode(result.publicKey.slice(8)).length !== 32 ||
                typeof result.signature !== 'string' ||
                base64.decode(result.signature).length !== 64
              )
                fail('invalid_signature', 'The wallet returned a malformed NEP-413 signature.');
            } catch {
              fail('invalid_signature', 'The wallet returned a malformed NEP-413 signature.');
            }
            return result;
          });
        } catch (error) {
          if (error instanceof BrowserWalletError) throw error;
          if (error instanceof AnnonError && error.code === 'invalid_signature')
            fail('invalid_signature', 'The wallet returned an invalid NEP-413 ownership proof.');
          throw error;
        }
        await selected();
      }),
  };
}

/** Sign only the hosting payload; no callback URL or page state is authorized. */
export async function signNearUpload(
  provider: BrowserNearProvider,
  input: UploadIntent,
  nearRpc: string,
): Promise<UploadAuth & { kind: 'near' }> {
  const intent = parseUploadIntent(input);
  if (intent.seller.kind !== 'near') throw new AnnonError('wrong_identity');
  return checked(async () => {
    const selected = async () => {
      if (!provider.getAccounts || !provider.signMessage)
        fail('missing_method', 'NEAR hosting requires NEP-413 signing.');
      const accounts = await provider.getAccounts();
      if (!accounts.some((a) => a.accountId === intent.seller.id))
        fail('wrong_identity', 'Select the requested NEAR identity.');
    };
    await selected();
    const payload = {
      message: uploadText(intent),
      recipient: intent.hostOrigin,
      nonce: bytes(intent.nonce, 32),
    };
    const result = await present(provider.signMessage, 'invalid_response').call(provider, {
      ...payload,
      nonce: payload.nonce.slice(),
    });
    await verifyNearMessage(intent.seller.id, payload, result, nearRpc);
    await selected();
    return {
      kind: 'near',
      accountId: present(result, 'invalid_response').accountId,
      publicKey: present(result, 'invalid_response').publicKey,
      signature: present(result, 'invalid_response').signature,
    };
  });
}
