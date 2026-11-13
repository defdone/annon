import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type AnnonErrorCode, isAnnonErrorCode } from '../errors.js';
import { fileStore } from '../pay/store-node.js';
import { AdapterError } from './errors.js';

interface GateRecord {
  id: string;
  revision: number;
  nextAllowedAt: number;
  code: AnnonErrorCode;
}
interface Context {
  stateDir: string;
  network: string;
  contractId: string;
  purchaseId: string;
  host?: string;
  fileId?: string;
}
/** Host and deployment are operator-checked; grants and URL paths never reset a purchase wait. */
export function retryGate(c: Context, now = () => Date.now() / 1000) {
  const dir = join(c.stateDir, 'retry-gates');
  const store = fileStore<GateRecord>(dir);
  const id = JSON.stringify([
    c.network,
    c.contractId,
    c.host ?? null,
    c.purchaseId,
    c.fileId ?? null,
  ]);
  return {
    async check() {
      const saved = await store.load(id);
      if (!saved) return;
      if (
        !isAnnonErrorCode(saved.code) ||
        !Number.isFinite(saved.nextAllowedAt) ||
        saved.nextAllowedAt < 0
      )
        throw new AdapterError('invalid_record', 'Invalid saved retry gate.', 2);
      const remaining = Math.ceil(saved.nextAllowedAt - now());
      if (remaining > 0)
        throw Object.assign(
          new AdapterError(saved.code, 'Wait before retrying this saved purchase.', 4),
          {
            retryAfterSeconds: remaining,
            purchaseId: c.purchaseId,
            ...(c.fileId ? { fileId: c.fileId } : {}),
          },
        );
    },
    async defer(code: AnnonErrorCode, seconds: number) {
      if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.ceil(seconds)))
        return;
      const nextAllowedAt = now() + Math.ceil(seconds);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (;;) {
        const before = await store.load(id);
        if (before && before.nextAllowedAt >= nextAllowedAt) return;
        if (
          await store.compareAndSet(id, before, {
            id,
            revision: (before?.revision ?? -1) + 1,
            nextAllowedAt,
            code,
          })
        )
          return;
      }
    },
  };
}
