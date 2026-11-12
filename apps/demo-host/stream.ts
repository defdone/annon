import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { HostResponse } from '../../packages/annon/src/download/host.ts';

/** Coverage advances only after the response write callback succeeds. */
export async function sendBody(result: HostResponse, res: ServerResponse) {
  if (!result.body) {
    res.end();
    return;
  }
  if (!result.delivery) {
    await pipeline(Readable.fromWeb(result.body as NodeReadableStream<Uint8Array>), res).catch(
      () => {},
    );
    return;
  }
  const delivery = result.delivery;
  const reader = result.body.getReader();
  let offset = Number(/^bytes (\d+)-/.exec(result.headers['Content-Range'] ?? '')?.[1] ?? 0);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  res.once('close', cancel);
  try {
    for (;;) {
      if (res.destroyed) throw new Error('response closed');
      const chunk = await reader.read();
      if (res.destroyed) throw new Error('response closed');
      if (chunk.done) break;
      await new Promise<void>((resolve, reject) => {
        res.write(chunk.value, (error) => (error ? reject(error) : resolve()));
      });
      offset += chunk.value.byteLength;
      await delivery.wrote(offset);
    }
    await delivery.prepare();
    if (res.destroyed) throw new Error('response closed');
    await new Promise<void>((resolve, reject) => {
      const close = () => {
        res.off('finish', finish);
        reject(new Error('response closed'));
      };
      const finish = () => {
        res.off('close', close);
        resolve();
      };
      res.once('close', close);
      res.once('finish', finish);
      res.end();
    });
    await delivery.finish();
  } catch {
    await delivery.interrupt();
    res.destroy();
  } finally {
    res.off('close', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
