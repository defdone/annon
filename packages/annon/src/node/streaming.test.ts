import { createHash, randomFillSync } from 'node:crypto';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { base58 } from '@scure/base';
import { afterEach, expect, it, vi } from 'vitest';
import { terms as initial } from '../../test/fixtures.js';
import { Annon } from '../api/annon.js';
import * as downloadModule from '../download/download.js';
import { fileAppId, hashPoint, keyFromSecret } from '../keys/near-ckd.js';
import { encryptedRecoveryStore, type RecoveryRecord } from '../pay/backup.js';
import { bytes, hex } from '../settle-near/codec.js';
import { termsHash } from '../settle-near/terms.js';
import { createAdapter } from './adapter.js';
import { runCli } from './cli.js';
import { fileSource } from './io.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function digest(path: string) {
  const hash = createHash('sha256');
  await (await fileSource(path)).read().pipeTo(
    new WritableStream({
      write: (chunk) => {
        hash.update(chunk);
      },
    }),
  );
  return hash.digest('hex');
}

async function harness(
  dir: string,
  beforeSend?: (method: string) => Promise<void>,
  afterHeader?: () => Promise<void>,
) {
  // Synthetic local CKD domain and grant. No wallet, keychain or external transport is used.
  const msk = 12345n;
  const pk = bls.G2.Point.BASE.multiply(msk);
  const mpcKey = `bls12381g2:${base58.encode(pk.toBytes(true))}`;
  const secret = new Uint8Array(32).fill(7);
  const buyerKey = hex(keyFromSecret(secret).publicKeyBytes);
  const identity = { kind: 'near' as const, id: initial.contract };
  let terms = { ...initial, seller: identity, base: null };
  let headerHash: string | null = null;
  const id = initial.file_id;
  const answer = (key: string) => {
    const sig = hashPoint(pk, fileAppId(terms.contract, bytes(terms.file_id, 32))).multiply(msk);
    return {
      big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
      big_c: `bls12381g1:${base58.encode(sig.add(bls.G1.Point.fromBytes(bytes(key, 48)).multiply(77n)).toBytes(true))}`,
    };
  };
  const sends: string[] = [];
  const send = async (method: string, args: object) => {
    sends.push(method);
    await beforeSend?.(method);
    if (method === 'register') {
      const a = args as { args: { terms: typeof terms; seller_key: string } };
      terms = a.args.terms;
      return answer(a.args.seller_key);
    }
    if (method === 'publish_header') {
      headerHash = (args as { header_hash: string }).header_hash;
      return null;
    }
    if (method === 'claim_key') return answer(buyerKey);
    throw new Error(`Unexpected send: ${method}`);
  };
  let remote = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === 'https://files.example/file/header') {
      const input = await open(join(dir, 'sealed.pay2'), 'r');
      try {
        const fixed = Buffer.alloc(54);
        await input.read(fixed, 0, fixed.length, 0);
        const header = Buffer.alloc(fixed.readUInt32BE(8));
        await input.read(header, 0, header.length, 0);
        await afterHeader?.();
        return new Response(header);
      } finally {
        await input.close();
      }
    }
    if (String(url) === 'https://files.example/file') {
      if (new Headers(init?.headers).get('range')?.startsWith('bytes=0-')) {
        await afterHeader?.();
        const source = await fileSource(join(dir, 'sealed.pay2'));
        return new Response(source.read());
      }
      remote = true;
      const start = Number(new Headers(init?.headers).get('range')?.match(/bytes=(\d+)-/)?.[1]);
      const source = await fileSource(join(dir, 'sealed.pay2'));
      return new Response(source.read(start), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${source.size - 1}/${source.size}`,
          'content-length': String(source.size - start),
        },
      });
    }
    if (String(url) !== 'https://rpc.example') throw new Error('Unexpected external access');
    const q = JSON.parse(String(init?.body));
    const method = q.params.method_name;
    const result =
      method === 'get_config'
        ? {
            network: terms.network,
            near_usdc: terms.near.token,
            usdc: initial.base?.usdc,
            intents: terms.contract,
            mpc: terms.contract,
            ckd_domain: 2,
            foreign_tx_domain: 3,
          }
        : method === 'public_key'
          ? mpcKey
          : method === 'get_file'
            ? {
                terms,
                terms_hash: termsHash(terms),
                header_hash: headerHash,
                sales_stopped_at: null,
                taken_down: null,
              }
            : method === 'get_purchase'
              ? {
                  purchase_id: id,
                  file_id: terms.file_id,
                  terms_hash: termsHash(terms),
                  recovery: identity,
                  buyer_key: buyerKey,
                  route: 'near-usdc',
                  delivery: 0,
                  accepted_at: 1,
                  grants: 1,
                }
              : method === 'get_grant'
                ? { purchase_id: id, grant: 0, buyer_key: buyerKey }
                : undefined;
    if (result === undefined) throw new Error(`Unexpected view: ${method}`);
    return Response.json({
      id: q.id,
      result: { result: [...Buffer.from(JSON.stringify(result))] },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      nearRpc: 'https://rpc.example',
      baseRpc: 'https://base.example',
      contractId: initial.contract,
      network: initial.network,
      trustContract: true,
      stateDir: dir,
    }),
  );
  const adapter = createAdapter(
    { ANNON_CONFIG: join(dir, 'config.json'), ANNON_BACKUP_SECRET: 'ab'.repeat(32) },
    {
      fetch: fetcher,
      wallet: async () => ({
        identity,
        authorize: async () => undefined,
        call: async () => {
          throw new Error('Unexpected wallet call');
        },
      }),
      sdk(options) {
        const sdk = new Annon({ ...options, send });
        const recovery: RecoveryRecord = {
          kind: 'recovery',
          id: `recovery:${id}`,
          revision: 0,
          purchase_id: id,
          file_id: terms.file_id,
          recovery: identity,
          buyerSecret: hex(secret),
          fresh_key: buyerKey,
          nonce: hex(new Uint8Array(32)),
          grant: 0,
          deadline: 1800000000,
        };
        // Saved final recovery grants exercise the same CLI lookup as an imported backup.
        storeRecovery = async () => {
          recovery.file_id = terms.file_id;
          await encryptedRecoveryStore(options.rawStore, options.backupSecret).compareAndSet(
            `annon/recovery/${id}`,
            null,
            recovery,
          );
        };
        return sdk;
      },
    },
  );
  let storeRecovery: () => Promise<void> = async () => {
    throw new Error('sell first');
  };
  const cli = async (args: string[]) => {
    let result: { ok: boolean; result?: Record<string, unknown>; error?: unknown } | undefined;
    const code = await runCli([...args, '--json'], adapter, (text) => {
      result = JSON.parse(text);
    });
    if (code !== 0) throw new Error(JSON.stringify(result));
    return result?.result;
  };
  return {
    cli,
    sends,
    adapter,
    id,
    get remote() {
      return remote;
    },
    save: () => storeRecovery(),
  };
}

async function roundTrip(size: number, remote: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'annon-stream-cli-'));
  try {
    const h = await harness(dir);
    const input = join(dir, 'input');
    const output = join(dir, 'opened');
    const sealed = join(dir, 'sealed.pay2');
    const started = performance.now();
    const file = await open(input, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let at = 0; at < size; at += buffer.length) {
        randomFillSync(buffer);
        await file.writeFile(buffer.subarray(0, Math.min(buffer.length, size - at)));
      }
    } finally {
      await file.close();
    }
    const generated = performance.now();
    await h.cli([
      'sell',
      input,
      '--price',
      '1',
      '--split',
      `near:${initial.contract}:10000`,
      '--output',
      sealed,
    ]);
    const sold = performance.now();
    await h.save();
    await h.cli([
      'open',
      h.id,
      ...(remote ? ['--url', 'https://files.example/file'] : ['--file', sealed]),
      '--output',
      output,
    ]);
    const opened = performance.now();
    expect(await digest(output)).toBe(await digest(input));
    expect(h.remote).toBe(remote);
    expect(h.sends).toEqual(['register', 'publish_header', 'claim_key']);
    if (process.env.ANNON_LARGE_FILES === '1')
      expect(process.resourceUsage().maxRSS).toBeLessThan(1024 * 1024);
    process.stdout.write(
      `${JSON.stringify({
        size,
        remote,
        peakRSSKiB: process.resourceUsage().maxRSS,
        generateSeconds: (generated - started) / 1000,
        sellSeconds: (sold - generated) / 1000,
        openSeconds: (opened - sold) / 1000,
        totalSeconds: (performance.now() - started) / 1000,
      })}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it.each([false, true])(
  'CLI streams a multi-chunk file (download %s)',
  async (remote) => {
    await roundTrip(9 * 1024 * 1024 + 3, remote);
  },
  120000,
);

it.runIf(process.env.ANNON_LARGE_FILES === '1').each([100, 1024, 3072])(
  'CLI large random file: %i MiB',
  async (mib) => {
    await roundTrip(mib * 1024 * 1024, true);
  },
  900000,
);

it('CLI removes provisional plaintext when the final encrypted chunk is tampered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-stream-tamper-'));
  try {
    const h = await harness(dir);
    const input = join(dir, 'input');
    const sealed = join(dir, 'sealed.pay2');
    await writeFile(input, new Uint8Array(9 * 1024 * 1024));
    await h.cli([
      'sell',
      input,
      '--price',
      '1',
      '--split',
      `near:${initial.contract}:10000`,
      '--output',
      sealed,
    ]);
    await h.save();
    const file = await open(sealed, 'r+');
    try {
      const info = await file.stat();
      const last = new Uint8Array(1);
      await file.read(last, 0, 1, info.size - 1);
      last[0] = (last[0] as number) ^ 1;
      await file.write(last, 0, 1, info.size - 1);
    } finally {
      await file.close();
    }
    await expect(
      h.cli(['open', h.id, '--file', sealed, '--output', join(dir, 'opened')]),
    ).rejects.toThrow();
    expect(await readdir(dir)).not.toContain('opened');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(h.sends).not.toContain('claim_key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

it.each(['contents', 'shorter', 'longer'])(
  'CLI reports source_changed and keeps sell resumable when plaintext becomes %s between passes',
  async (change) => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-cli-seal-change-'));
    const input = join(dir, 'input');
    const sealed = join(dir, 'sealed.pay2');
    try {
      await writeFile(input, new Uint8Array(65540).fill(3));
      const h = await harness(dir, async (method) => {
        if (method === 'register')
          await writeFile(
            input,
            new Uint8Array(change === 'shorter' ? 65539 : change === 'longer' ? 65541 : 65540).fill(
              4,
            ),
          );
      });
      let result: Record<string, unknown> = {};
      expect(
        await runCli(
          [
            'sell',
            input,
            '--price',
            '1',
            '--split',
            `near:${initial.contract}:10000`,
            '--output',
            sealed,
            '--json',
          ],
          h.adapter,
          (text) => {
            result = JSON.parse(text);
          },
        ),
      ).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'source_changed',
          fileId: expect.any(String),
          message: expect.stringContaining('Resume'),
        },
      });
      expect(await readdir(dir)).not.toContain('sealed.pay2');
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      await writeFile(input, new Uint8Array(65540).fill(3));
      const fileId = (result.error as { fileId: string }).fileId;
      await h.cli(['sell', input, '--resume', fileId, '--output', sealed]);
      expect(await readdir(dir)).toContain('sealed.pay2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('CLI removes provisional output if ciphertext changes between open passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-cli-open-change-'));
  const input = join(dir, 'input');
  const sealed = join(dir, 'sealed.pay2');
  try {
    const h = await harness(dir, async (method) => {
      if (method !== 'claim_key') return;
      const handle = await open(sealed, 'r+');
      try {
        const size = (await handle.stat()).size;
        const last = new Uint8Array(1);
        await handle.read(last, 0, 1, size - 1);
        last[0] = (last[0] as number) ^ 1;
        await handle.write(last, 0, 1, size - 1);
      } finally {
        await handle.close();
      }
    });
    await writeFile(input, new Uint8Array(65540));
    await h.cli([
      'sell',
      input,
      '--price',
      '1',
      '--split',
      `near:${initial.contract}:10000`,
      '--output',
      sealed,
    ]);
    await h.save();
    await expect(
      h.cli(['open', h.id, '--file', sealed, '--output', join(dir, 'opened')]),
    ).rejects.toThrow();
    expect(h.sends).toContain('claim_key');
    expect(await readdir(dir)).not.toContain('opened');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not create a download stream when the final exclusive output check loses a race', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-cli-output-race-'));
  try {
    const output = join(dir, 'opened');
    const h = await harness(dir, undefined, () => writeFile(output, 'competing output'));
    const input = join(dir, 'input');
    const sealed = join(dir, 'sealed.pay2');
    await writeFile(input, new Uint8Array(65540));
    await h.cli([
      'sell',
      input,
      '--price',
      '1',
      '--split',
      `near:${initial.contract}:10000`,
      '--output',
      sealed,
    ]);
    await h.save();
    const download = vi.spyOn(downloadModule, 'download');
    await expect(
      h.cli(['open', h.id, '--url', 'https://files.example/file', '--output', output]),
    ).rejects.toThrow('output_exists');
    expect(download).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
