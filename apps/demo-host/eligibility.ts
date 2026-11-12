import type { FileInfo } from '../../packages/annon/src/near/rpc.ts';
import { parseRetryAfterMs } from '../../packages/annon/src/net/retry.ts';
import { PayError } from '../../packages/annon/src/pay/base.ts';

export async function requireEligibility(
  file: FileInfo,
  o: {
    origin: string;
    contract: string;
    fileId: string;
    now?: () => number;
    fetcher?: typeof fetch;
  },
): Promise<void> {
  const unavailable = (seconds = 30): never => {
    const error = new PayError('relayer_unavailable');
    error.retryAfterSeconds = seconds;
    throw error;
  };
  const url = new URL(o.origin);
  if (url.protocol !== 'https:' || url.origin !== o.origin || url.username || url.password)
    return unavailable();
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  try {
    const response = await (o.fetcher ?? fetch)(`${o.origin}/v1/base-eligibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: o.fileId, termsHash: file.termsHash }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(
        Math.ceil((parseRetryAfterMs(response.headers.get('Retry-After')) ?? 30000) / 1000),
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return unavailable();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) return unavailable();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = JSON.parse(new TextDecoder().decode(buffer));
    if (
      !result ||
      result.network !== file.terms.network ||
      result.contract !== o.contract ||
      result.fileId !== o.fileId ||
      result.termsHash !== file.termsHash ||
      typeof result.eligible !== 'boolean'
    )
      return unavailable();
    if (result.eligible === false) throw new PayError('not_sponsored');
    if (
      !['listed', 'pool', 'legacy', 'external'].includes(result.tier) ||
      typeof result.policyVersion !== 'string' ||
      !result.policyVersion ||
      !/^\d+$/.test(result.minPrice) ||
      !result.fee ||
      !/^\d+$/.test(result.fee.fixed) ||
      !Number.isSafeInteger(result.fee.bps) ||
      result.fee.bps < 0 ||
      result.fee.bps > 10000 ||
      !Number.isSafeInteger(result.decidedAt) ||
      result.decidedAt < 0 ||
      !Number.isSafeInteger(result.checkedAt) ||
      result.checkedAt < 0 ||
      now - result.checkedAt > 30 ||
      result.checkedAt > now + 5
    )
      return unavailable();
  } catch (e) {
    if (e instanceof PayError) throw e;
    return unavailable();
  }
}
