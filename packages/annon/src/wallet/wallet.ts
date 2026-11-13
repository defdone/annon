/** Wallet adapters: authoritative text in, checked authorization out. No browser globals. */
import { base64 } from '@scure/base';
import type { Account } from 'near-api-js';
import { signMessage as signNearMessage } from 'near-api-js/nep413';
import { createWalletClient, custom, type EIP1193Provider } from 'viem';
import { base } from 'viem/chains';
import { AnnonError } from '../errors.js';
import {
  type NearMessage,
  type NearSignedMessage,
  proveNearControl,
  type RecoveryProofContext,
} from '../near/nep413.js';
import { readOutcome } from '../near/rpc.js';
import type { TypedData } from '../pay/eip3009.js';
import { hex, account as nearAccount } from '../settle-near/codec.js';
import {
  type Authorization,
  type Identity,
  parseIdentity,
  solanaWalletAuth,
  verifyAuthorization,
} from '../settle-near/identity.js';
import { parsePurchaseMessage } from '../settle-near/purchase.js';
import type { SettlementAssets } from '../settle-near/terms.js';

export interface IdentityWallet {
  identity: Identity;
  authorize(text: string): Promise<Authorization | undefined>;
}
export interface EvmWallet extends IdentityWallet {
  address: string;
  signTypedData(data: TypedData): Promise<string>;
}
/** Accept an EIP-1193 provider or the provider member of an EIP-6963 announcement. */
export function evmWallet(
  input:
    | { request(args: { method: string; params?: unknown }): Promise<unknown> }
    | { provider: { request(args: { method: string; params?: unknown }): Promise<unknown> } },
  address: string,
): EvmWallet {
  const provider = 'provider' in input ? input.provider : input;
  const identity = parseIdentity({ kind: 'evm', id: address });
  const client = createWalletClient({
    chain: base,
    transport: custom(provider as EIP1193Provider),
  });
  const selected = async () => {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (
      !Array.isArray(accounts) ||
      !accounts.some((a) => typeof a === 'string' && a.toLowerCase() === identity.id)
    )
      throw new AnnonError('wrong_identity', 'wallet does not control the selected identity');
  };
  return {
    identity,
    address: identity.id,
    async authorize(text) {
      await selected();
      const sig = await client.signMessage({
        account: identity.id as `0x${string}`,
        message: text,
      });
      const auth: Authorization = { kind: 'evm', sig };
      if (!verifyAuthorization(identity, text, auth))
        throw new AnnonError('invalid_signature', 'wallet signature does not match identity');
      return auth;
    },
    async signTypedData(data) {
      await selected();
      return client.signTypedData({
        ...data,
        account: identity.id as `0x${string}`,
      } as unknown as Parameters<typeof client.signTypedData>[0]);
    },
  };
}
export interface SolanaAccount {
  publicKey: Uint8Array;
  address: string;
}
export interface SolanaStandard {
  features: {
    'solana:signMessage': {
      signMessage(
        ...inputs: { account: SolanaAccount; message: Uint8Array }[]
      ): Promise<readonly { signature: Uint8Array; signedMessage: Uint8Array }[]>;
    };
  };
}
export function solanaWallet(wallet: SolanaStandard, account: SolanaAccount): IdentityWallet {
  const identity = parseIdentity({ kind: 'solana', id: hex(account.publicKey).slice(2) });
  return {
    identity,
    async authorize(text) {
      const results = await wallet.features['solana:signMessage'].signMessage({
        account,
        message: new TextEncoder().encode(text),
      });
      if (results.length !== 1 || !results[0])
        throw new AnnonError('invalid_signature', 'wallet returned no single signature');
      return solanaWalletAuth(identity, text, results[0]);
    },
  };
}
export interface NearCall {
  receiverId: string;
  method: string;
  args: object;
  gas?: bigint;
  deposit?: bigint;
}
export interface NearWallet extends IdentityWallet {
  call(call: NearCall): Promise<unknown>;
  transferPurchase(message: string, assets?: SettlementAssets): Promise<unknown>;
  /** Adapters default to NEP-413 plus a final full-access-key check before using NEAR recovery. */
  proveControl?: (text: string, context: RecoveryProofContext) => Promise<void>;
}
function nearWallet(
  accountId: string,
  selected: () => Promise<void>,
  call: (call: NearCall) => Promise<unknown>,
  proveControl?: NearWallet['proveControl'],
): NearWallet {
  const identity = parseIdentity({ kind: 'near', id: accountId });
  return {
    identity,
    ...(proveControl ? { proveControl } : {}),
    async authorize(_text) {
      await selected();
      return undefined;
    },
    async call(request) {
      await selected();
      return call(request);
    },
    async transferPurchase(message, assets) {
      const p = parsePurchaseMessage(message, assets);
      if (p.route !== 'near-usdc') throw new TypeError('not a NEAR USDC purchase');
      if (BigInt(p.expires_at) <= BigInt(Math.floor(Date.now() / 1000)))
        throw new AnnonError('payment_expired', 'purchase expired');
      await selected();
      return call({
        receiverId: p.asset,
        method: 'ft_transfer_call',
        args: { receiver_id: p.contract, amount: p.price, msg: message },
        gas: 150000000000000n,
        deposit: 1n,
      });
    },
  };
}
export interface SelectorWallet {
  signMessage?: (p: NearMessage) => Promise<NearSignedMessage | undefined>;
  getAccounts(): Promise<readonly { accountId: string }[]>;
  signAndSendTransaction(tx: {
    signerId: string;
    receiverId: string;
    actions: {
      type: 'FunctionCall';
      params: { methodName: string; args: object; gas: string; deposit: string };
    }[];
  }): Promise<unknown>;
}
export function nearSelectorWallet(
  wallet: SelectorWallet,
  accountId: string,
  proveControl?: NearWallet['proveControl'],
): NearWallet {
  return nearWallet(
    accountId,
    async () => {
      if (!(await wallet.getAccounts()).some((a) => a.accountId === accountId))
        throw new AnnonError('wrong_identity', 'wallet does not control the NEAR account');
    },
    (call) =>
      wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: call.receiverId,
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: call.method,
              args: call.args,
              gas: String(call.gas ?? 300000000000000n),
              deposit: String(call.deposit ?? 0n),
            },
          },
        ],
      }),
    proveControl ??
      ((text, context) => {
        if (!wallet.signMessage)
          throw new AnnonError('missing_method', 'NEAR recovery requires NEP-413 signMessage');
        return proveNearControl(
          accountId,
          text,
          context,
          (p) => wallet.signMessage?.(p) ?? Promise.resolve(undefined),
        );
      }),
  );
}
/** Pass a near-api-js Account constructed with a KeyPair signer. The account sends the call itself. */
export function nearKeyPairWallet(
  account: {
    accountId: string;
    getSigner?: Account['getSigner'];
    callFunction(args: {
      contractId: string;
      methodName: string;
      args: object;
      gas: bigint;
      deposit: bigint;
    }): Promise<unknown>;
  },
  proveControl?: NearWallet['proveControl'],
): NearWallet {
  return nearWallet(
    account.accountId,
    async () => {},
    (call) =>
      account.callFunction({
        contractId: call.receiverId,
        methodName: call.method,
        args: call.args,
        gas: call.gas ?? 300000000000000n,
        deposit: call.deposit ?? 0n,
      }),
    proveControl ??
      (async (text, context) => {
        if (!account.getSigner)
          throw new AnnonError('missing_method', 'NEAR recovery requires a NEP-413 signer');
        await proveNearControl(account.accountId, text, context, async (payload) => {
          const result = await signNearMessage({ signerAccount: account as Account, payload });
          return {
            accountId: result.accountId,
            publicKey: result.publicKey.toString(),
            signature: base64.encode(result.signature),
          };
        });
      }),
  );
}

/** Prepay Annon storage explicitly before zero-deposit register/reopen calls. */
export async function storageDeposit(
  wallet: Pick<NearWallet, 'call'>,
  contract: string,
  amount: bigint,
): Promise<unknown> {
  if (amount <= 0n) throw new RangeError('storage deposit must be positive');
  return wallet.call({
    receiverId: nearAccount(contract),
    method: 'storage_deposit',
    args: {},
    deposit: amount,
    gas: 30000000000000n,
  });
}

/** A final funding refusal, safe to correct and retry. */
export class FileFundingRefused extends AnnonError {
  readonly code = 'funding_refused';
  constructor() {
    super('funding_refused', 'File funding was refused.');
    this.name = 'FileFundingRefused';
  }
}

/** Explicit, nonwithdrawable purchase storage allocation. Zero attachment uses own prepaid balance. */
export async function fundFileStorage(
  wallet: Pick<NearWallet, 'call'>,
  contract: string,
  fileId: string,
  amount: bigint,
  prepaid = false,
): Promise<unknown> {
  if (amount <= 0n || amount >= 2n ** 128n || !/^0x[0-9a-f]{64}$/.test(fileId))
    throw new RangeError('invalid file funding');
  const request = {
    receiverId: nearAccount(contract),
    method: 'fund_file_storage',
    args: { file_id: fileId, amount: amount.toString() },
    deposit: prepaid ? 0n : amount,
    gas: 30000000000000n,
  };
  const refused = (result: unknown) => {
    if (!result || typeof result !== 'object' || !('transaction' in result)) return false;
    try {
      const transaction = (result as { transaction: { hash: string; signer_id: string } })
        .transaction;
      return (
        readOutcome(result, contract, {
          txHash: transaction.hash,
          signer: transaction.signer_id,
          method: request.method,
          args: request.args,
        }).state === 'refused'
      );
    } catch {
      return false;
    }
  };
  let result: unknown;
  try {
    result = await wallet.call(request);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'transactionResult' in error &&
      refused(error.transactionResult)
    )
      throw new FileFundingRefused();
    throw error;
  }
  if (refused(result)) throw new FileFundingRefused();
  return result;
}
