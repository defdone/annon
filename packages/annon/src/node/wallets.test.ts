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

it('uses only an explicitly named near-cli-rs keychain entry through an injected reader', async () => {
  const { KeyPair } = await import('near-api-js');
  const key = KeyPair.fromRandom('ed25519');
  const read = vi.fn(async () =>
    JSON.stringify({
      account_id: 'bot.near',
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    }),
  );
  const keychain = { read, create: vi.fn() };
  await loadWallet(
    {
      wallet: 'near',
      nearAccount: 'bot.near',
      nearPublicKey: key.getPublicKey().toString(),
      network: 'near:testnet',
    },
    {},
    'https://rpc',
    keychain,
  );
  expect(read).toHaveBeenCalledWith(`near-testnet-bot.near/bot.near:${key.getPublicKey()}`);
  read.mockClear();
  await expect(loadWallet({ wallet: 'near' }, {}, 'https://rpc', keychain)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('omits credentials and rejects redirects on both Base RPC clients', async () => {
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    expect(options?.credentials).toBe('omit');
    expect(options?.redirect).toBe('error');
    const request = JSON.parse(String(options?.body));
    if (request.method === 'eth_chainId')
      return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x2105' });
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'synthetic refusal' },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const wallet = await loadWallet(
      { wallet: 'evm' },
      { ANNON_EVM_PRIVATE_KEY: `0x${'42'.repeat(32)}` },
      'https://near.example',
    );
    await expect(
      wallet.sendBase?.(
        { to: `0x${'11'.repeat(20)}`, data: '0x' } as never,
        'https://base.example',
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalled();
    expect(
      fetcher.mock.calls.every(
        ([, options]) => options?.credentials === 'omit' && options?.redirect === 'error',
      ),
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
