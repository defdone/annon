import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAuthorization } from '../settle-near/identity.js';
import { loadWallet, readBackupSecret } from './wallets.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const directory = async () => {
  const d = await mkdtemp(join(tmpdir(), 'annon-wallet-'));
  dirs.push(d);
  return d;
};
describe('explicit wallet sources', () => {
  it('signs authoritative text with env EVM keys and named Solana keypair files', async () => {
    const evm = await loadWallet(
      { wallet: 'evm' },
      { ANNON_EVM_PRIVATE_KEY: `0x${'42'.repeat(32)}` },
      'https://rpc.example',
    );
    expect(verifyAuthorization(evm.identity, 'exact text', await evm.authorize('exact text'))).toBe(
      true,
    );
    const seed = new Uint8Array(32).fill(7);
    const file = join(await directory(), 'solana.json');
    await writeFile(file, JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]));
    const solana = await loadWallet(
      { wallet: 'solana', solanaKeyFile: file },
      {},
      'https://rpc.example',
    );
    expect(
      verifyAuthorization(solana.identity, 'exact text', await solana.authorize('exact text')),
    ).toBe(true);
  });
  it('reads near-cli-rs credential JSON and refuses an identity/key mismatch', async () => {
    const file = join(await directory(), 'near.json');
    const { KeyPair } = await import('near-api-js');
    const key = KeyPair.fromRandom('ed25519');
    await writeFile(
      file,
      JSON.stringify({
        account_id: 'alice.near',
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      }),
    );
    expect(
      (await loadWallet({ wallet: 'near', nearKeyFile: file }, {}, 'https://rpc.example')).identity,
    ).toEqual({ kind: 'near', id: 'alice.near' });
    await expect(
      loadWallet(
        { wallet: 'near', nearKeyFile: file, recovery: 'near:bob.near' },
        {},
        'https://rpc.example',
      ),
    ).rejects.toThrow();
  });
  it('requires a user-held backup secret and never creates one implicitly', async () => {
    await expect(readBackupSecret({}, {})).rejects.toThrow();
    const file = join(await directory(), 'backup.key');
    await writeFile(file, 'ab'.repeat(32));
    expect(await readBackupSecret({ backupSecretFile: file }, {})).toEqual(
      new Uint8Array(32).fill(0xab),
    );
    expect(await readFile(file, 'utf8')).toBe('ab'.repeat(32));
  });
  it('does not log malformed secret material', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    await expect(
      loadWallet({ wallet: 'evm' }, { ANNON_EVM_PRIVATE_KEY: 'SECRET' }, 'https://rpc.example'),
    ).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
