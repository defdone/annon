import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { base58 } from '@scure/base';
import { KeyPair } from 'near-api-js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Identity } from '../settle-near/identity.js';
/** Inject this boundary in every test. Entry is a public service/account reference, never a secret. */
export interface Keychain {
  read(entry: string): Promise<string>;
  create(
    kind: 'evm' | 'near',
    entry: string,
    nearAccount?: string,
  ): Promise<Identity & { publicKey?: string }>;
}
const entryParts = (entry: string) => {
  const [service, account = service] = entry.split('/');
  if (
    !service ||
    !account ||
    entry.split('/').length > 2 ||
    !/^[a-zA-Z0-9_.:@-]+$/.test(service + account)
  )
    throw new TypeError('invalid keychain reference');
  return { service, account };
};
export const osKeychain: Keychain = {
  async read(entry) {
    if (process.platform !== 'darwin')
      throw new Error(
        'OS keychain adapter currently requires macOS; use an env/file/remote signer',
      );
    const { service, account } = entryParts(entry);
    const { stdout } = await promisify(execFile)(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 10000, maxBuffer: 16384 },
    );
    return stdout.trim();
  },
  async create(kind, entry, nearAccount) {
    if (process.platform !== 'darwin')
      throw new Error('OS keychain adapter currently requires macOS');
    const { service, account } = entryParts(entry);
    let secret: string;
    let identity: Identity & { publicKey?: string };
    if (kind === 'near') {
      if (!nearAccount) throw new Error('NEAR account required');
      const key = KeyPair.fromRandom('ed25519');
      secret = JSON.stringify({
        account_id: nearAccount,
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      });
      identity = { kind, id: nearAccount, publicKey: key.getPublicKey().toString() };
    } else {
      secret = generatePrivateKey();
      identity = { kind, id: privateKeyToAccount(secret as `0x${string}`).address.toLowerCase() };
    }
    // An empty trusted-app ACL removes the creator (security) from automatic access.
    // Reads require macOS approval; never trust the generic security executable.
    // Feed security's command interpreter via stdin, keeping secrets out of process arguments.
    // Base58 is an encoding inside the keychain, not a config-file credential.
    const encoded = base58.encode(new TextEncoder().encode(secret));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let failed = false;
      child.stderr.on('data', (b) => {
        if (/SecKeychain|Error|error|already exists/.test(String(b))) failed = true;
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 && !failed ? resolve() : reject(new Error('keychain storage failed')),
      );
      child.stdin.end(`add-generic-password -s ${service} -a ${account} -T "" -w ${encoded}\n`);
    });
    return identity;
  },
};
export function decodeKeychain(value: string): string {
  if (value.startsWith('{') || value.startsWith('0x')) return value;
  return new TextDecoder().decode(base58.decode(value));
}
