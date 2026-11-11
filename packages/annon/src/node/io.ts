import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdtemp, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReplayableSource } from '../envelope/replay.js';
import { AdapterError } from './errors.js';

/** Also supplies serveFile's size/read(start) interface without buffering the disk file. */
export async function fileSource(path: string): Promise<
  ReplayableSource & {
    read(start?: number): ReadableStream<Uint8Array>;
  }
> {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError('expected a regular file');
  return {
    size: info.size,
    read: (start: number = 0) =>
      Readable.toWeb(createReadStream(path, { start, highWaterMark: 256 * 1024 }), {
        strategy: { highWaterMark: 256 * 1024, size: (chunk) => (chunk as Uint8Array).length },
      }) as ReadableStream<Uint8Array>,
  };
}

/** No requested output name is created until the producer and final authentication succeed. */
export async function withOutput<T>(
  path: string,
  write: (sink: WritableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  await newOutput(path);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    let result: T;
    try {
      result = await write(new WritableStream({ write: (chunk) => handle.writeFile(chunk) }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Hard-link the complete inode exclusively: the requested name is never empty.
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') await newOutput(path);
      throw error;
    }
    await unlink(temp);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return result;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function writeStream(path: string, stream: ReadableStream<Uint8Array>) {
  try {
    await withOutput(path, (sink) => stream.pipeTo(sink));
  } catch (error) {
    await stream.cancel(error).catch(() => {});
    throw error;
  }
}

/** Encrypted disk spool for a non-replayable download; always removed on success or failure. */
export async function withSpool<T>(
  output: string,
  stream: ReadableStream<Uint8Array>,
  use: (source: ReplayableSource) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(dirname(output), '.annon-spool-'));
  try {
    const path = join(dir, 'encrypted');
    await writeStream(path, stream);
    return await use(await fileSource(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function newOutput(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new AdapterError(
    'output_exists',
    'Choose a new output path; the existing file will not be overwritten.',
    2,
  );
}
/** Portable backups are complete and synced before the SDK proceeds to payment or key release. */
export async function writeBackup(path: string, content: string) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
