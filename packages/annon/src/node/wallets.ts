import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64 } from '@scure/base';
import { Account, KeyPair, type KeyPairString } from 'near-api-js';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { signNearUpload } from '../browser/wallets.js';
import type { UploadAuth, UploadIntent } from '../download/upload.js';
import { nep413Hash } from '../near/nep413.js';
import type { SplitCall } from '../pay/split.js';
import { bytes, hex } from '../settle-near/codec.js';
import { identityJson, parseIdentity } from '../settle-near/identity.js';
import { type EvmWallet, type IdentityWallet, nearKeyPairWallet } from '../wallet/wallet.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import { decodeKeychain, type Keychain, osKeychain } from './keychain.js';

export type Environment = Record<string, string | undefined>;
export type LocalWallet = IdentityWallet & {
  signUpload?: (intent: UploadIntent) => Promise<UploadAuth>;
  sendBase?: (call: SplitCall, rpc: string) => Promise<void>;
};
const credentialsError = () =>
  new AdapterError(
    'credentials_required',
    'Select a wallet and provide its key through the documented environment variable or a named key file. Check the recovery identity matches.',
    2,
  );
export function identity(value: string) {
  const at = value.indexOf(':');
  return parseIdentity({ kind: value.slice(0, at), id: value.slice(at + 1) });
}
async function source(file: string | undefined, env: string | undefined): Promise<string> {
  if (file) return (await readFile(file, 'utf8')).trim();
  if (env) return env.trim();
  throw credentialsError();
}
export async function readBackupSecret(o: Partial<Input>, env: Environment): Promise<Uint8Array> {
  try {
    const text = await source(
      o.backupSecretFile ?? env.ANNON_BACKUP_SECRET_FILE,
      env.ANNON_BACKUP_SECRET,
    );
    return bytes(text.startsWith('0x') ? text : `0x${text}`, 32);
  } catch {
    throw new AdapterError(
      'backup_secret_required',
      'Provide a 32-byte random backup secret as 64 hex characters in ANNON_BACKUP_SECRET or a named backup secret file.',
      2,
    );
  }
}
export async function loadWallet(
  o: Partial<Input>,
  env: Environment,
  nearRpc: string,
  keychain: Keychain = osKeychain,
): Promise<LocalWallet> {
  try {
    const selected = o.wallet ?? (o.recovery ? identity(o.recovery).kind : env.ANNON_WALLET);
    let wallet: LocalWallet;
    if (selected === 'evm') {
      const key = await source(o.evmKeyFile ?? env.ANNON_EVM_KEY_FILE, env.ANNON_EVM_PRIVATE_KEY);
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw credentialsError();
      const account = privateKeyToAccount(key as `0x${string}`);
      const evm: EvmWallet & LocalWallet = {
        identity: parseIdentity({ kind: 'evm', id: account.address.toLowerCase() }),
        address: account.address.toLowerCase(),
        authorize: async (text) => ({
          kind: 'evm',
          sig: await account.signMessage({ message: text }),
        }),
        signTypedData: (data) => account.signTypedData(data as never),
        async sendBase(call, rpc) {
          const client = createWalletClient({
            account,
            chain: base,
            transport: http(rpc, { fetchOptions: { credentials: 'omit', redirect: 'error' } }),
          });
          const publicClient = createPublicClient({
            chain: base,
            transport: http(rpc, { fetchOptions: { credentials: 'omit', redirect: 'error' } }),
          });
          if ((await publicClient.getChainId()) !== base.id) throw new Error('wrong Base chain');
          const hash = await client.sendTransaction({
            to: call.to as `0x${string}`,
            data: call.data as `0x${string}`,
          });
          if ((await publicClient.waitForTransactionReceipt({ hash })).status !== 'success')
            throw new Error('split creation failed');
        },
      };
      wallet = evm;
    } else if (selected === 'solana') {
      const value: unknown = JSON.parse(
        await source(o.solanaKeyFile ?? env.ANNON_SOLANA_KEY_FILE, env.ANNON_SOLANA_KEYPAIR),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 64 ||
        value.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
      )
        throw credentialsError();
      const key = Uint8Array.from(value);
      const seed = key.subarray(0, 32);
      const publicKey = ed25519.getPublicKey(seed);
      if (hex(publicKey) !== hex(key.subarray(32))) throw credentialsError();
      wallet = {
        identity: parseIdentity({ kind: 'solana', id: hex(publicKey).slice(2) }),
        authorize: async (text) => ({
          kind: 'solana',
          sig: hex(ed25519.sign(new TextEncoder().encode(text), seed)),
        }),
      };
    } else if (selected === 'near') {
      const file = o.nearKeyFile ?? env.ANNON_NEAR_KEY_FILE;
      let raw: string;
      if (file || env.ANNON_NEAR_CREDENTIALS) raw = await source(file, env.ANNON_NEAR_CREDENTIALS);
      else {
        const account = o.nearAccount ?? env.ANNON_NEAR_ACCOUNT;
        const publicKey = o.nearPublicKey ?? env.ANNON_NEAR_PUBLIC_KEY;
        const network = (o.network ?? env.ANNON_NETWORK ?? 'near:mainnet').replace(/^near:/, '');
        if (
          !account ||
          !publicKey ||
          !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey) ||
          !['mainnet', 'testnet'].includes(network)
        )
          throw credentialsError();
        parseIdentity({ kind: 'near', id: account });
        raw = decodeKeychain(
          await keychain.read(`near-${network}-${account}/${account}:${publicKey}`),
        );
      }
      const c = JSON.parse(raw) as {
        account_id?: string;
        private_key?: string;
        public_key?: string;
      };
      const accountId = c.account_id ?? o.nearAccount ?? env.ANNON_NEAR_ACCOUNT;
      if (!accountId || !c.private_key?.startsWith('ed25519:')) throw credentialsError();
      parseIdentity({ kind: 'near', id: accountId });
      const key = KeyPair.fromString(c.private_key as KeyPairString);
      const expected = o.nearPublicKey ?? env.ANNON_NEAR_PUBLIC_KEY ?? c.public_key;
      if (expected && key.getPublicKey().toString() !== expected) throw credentialsError();
      if ((o.nearAccount ?? env.ANNON_NEAR_ACCOUNT ?? accountId) !== accountId)
        throw credentialsError();
      // Transport exception near_api_local_wallet: Account owns nonce lookup and broadcast.
      // Its provider uses the third-party Node fetch transport.
      const account = new Account(accountId, nearRpc, key.toString());
      wallet = {
        ...nearKeyPairWallet(account),
        signUpload: (intent) =>
          signNearUpload(
            {
              getAccounts: async () => [{ accountId }],
              signMessage: async (payload) => ({
                accountId,
                publicKey: key.getPublicKey().toString(),
                signature: base64.encode(key.sign(nep413Hash(payload)).signature),
              }),
            },
            intent,
            nearRpc,
          ),
      };
    } else throw credentialsError();
    if (o.recovery && identityJson(identity(o.recovery)) !== identityJson(wallet.identity))
      throw credentialsError();
    return wallet;
  } catch {
    throw credentialsError();
  }
}
