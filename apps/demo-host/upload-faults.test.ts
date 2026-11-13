import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';
import { parseUpload } from '../../packages/annon/src/download/upload.ts';
import { prepareSeal } from '../../packages/annon/src/envelope/replay.ts';
import type { FileInfo } from '../../packages/annon/src/near/rpc.ts';
import vectors from '../../specs/vectors/upload.json' with { type: 'json' };

const fault = vi.hoisted(() => ({ operation: '', suffix: '' }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  const fail = (operation: string, path: unknown) => {
    if (fault.operation === operation && String(path).endsWith(fault.suffix)) {
      fault.operation = '';
      throw Object.assign(new Error('Storage unavailable'), { code: 'EACCES' });
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fault.operation === 'truncate' && String(args[0]).endsWith(fault.suffix)) {
        fault.operation = '';
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'writeFile')
              return (data: Uint8Array) => target.writeFile(data.subarray(0, data.length - 1));
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return handle;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      fail('stat', args[0]);
      return actual.stat(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      fail('unlink', args[0]);
      return actual.unlink(...args);
    },
  };
});

import { hostCapacity } from './capacity.ts';
import { hostStorage } from './storage.ts';
import { initUploadState, uploadService } from './uploads.ts';

it.each(['stat', 'truncate'] as const)(
  'fails closed for storage faults during orphan removal and publication: %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'host-upload-io-'));
    try {
      const uploads = join(dir, 'uploads');
      await mkdir(uploads);
      await initUploadState(uploads);
      const orphan = join(uploads, `${'ab'.repeat(32)}.part`);
      await writeFile(orphan, 'orphan');
      const request = parseUpload(vectors.cases[0]?.request);
      const capacity = await hostCapacity(join(dir, 'capacity'));
      const config = {
        dir: uploads,
        capacity,
        network: request.intent.network,
        contract: request.intent.contract,
        hostOrigin: request.intent.hostOrigin,
        nearRpc: 'https://near.invalid',
        signingKey: new Uint8Array(32).fill(7),
        sellers: [],
        now: () => 1794528000000,
        getFile: async () =>
          ({
            terms: request.terms,
            termsHash: request.intent.termsHash,
            takenDown: null,
            salesStoppedAt: null,
            headerHash: null,
          }) as FileInfo,
      };
      fault.operation = 'unlink';
      fault.suffix = '.part';
      await expect(uploadService(config)).rejects.toMatchObject({ code: 'EACCES' });
      const host = await uploadService(config);
      const id = (await host.create(request, 'ip')).body.uploadId;
      await host.body(
        id,
        request,
        (async function* () {
          yield Buffer.from(vectors.bodyHex, 'hex');
        })(),
      );
      const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
      const seal = await prepareSeal(new Uint8Array(32).fill(3), new Uint8Array(1024).fill(8), {
        fileId: new Uint8Array(32).fill(2),
        name: 'file.txt',
        mime: 'text/plain',
        version: 2,
        authKind: 0,
        chunkLog2: 22,
      });
      const final = await seal.finish({
        seller: request.intent.seller,
        contractId: request.intent.contract,
        ckdSecret: new Uint8Array(48).fill(4),
        sign: (message) => account.signMessage({ message }),
      });
      fault.operation = mode;
      fault.suffix = mode === 'stat' ? '.pay2' : '.assembly';
      await expect(host.header(id, request, final.header)).rejects.toMatchObject({
        code: mode === 'stat' ? 'EACCES' : 'upload_incomplete',
      });
    } finally {
      fault.operation = '';
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(['directory', 'ready-temp', 'initializing'] as const)(
  'fails closed for non-missing initialization IO errors at %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'host-init-io-'));
    try {
      if (mode === 'directory') {
        const storage = await hostStorage(dir);
        await storage.close();
        fault.operation = 'stat';
        fault.suffix = '/seller';
      } else {
        fault.operation = 'unlink';
        fault.suffix = mode === 'ready-temp' ? '.host-ready.tmp' : '.host-initializing';
      }
      await expect(hostStorage(dir)).rejects.toMatchObject({ code: 'EACCES' });
      if (mode === 'directory') expect(await readFile(join(dir, '.host-ready'), 'utf8')).toBe('2');
    } finally {
      fault.operation = '';
      await rm(dir, { recursive: true, force: true });
    }
  },
);
