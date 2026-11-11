import { link, mkdtemp, open, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fileSource, withOutput, withSpool, writeStream } from './io.js';

it('streams disk ranges and publishes only a completely written output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-io-'));
  try {
    const input = join(dir, 'input');
    const output = join(dir, 'output');
    await writeFile(input, new Uint8Array(200000).fill(9));
    const source = await fileSource(input);
    expect(source.size).toBe(200000);
    await writeStream(output, source.read(123));
    expect((await readFile(output)).length).toBe(200000 - 123);
    await expect(writeStream(output, source.read())).rejects.toMatchObject({
      code: 'output_exists',
    });
    expect((await readdir(dir)).sort()).toEqual(['input', 'output']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('removes temporary plaintext on a late source failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-io-'));
  let pulls = 0;
  try {
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new Uint8Array(100000));
        else c.error(new Error('final authentication failed'));
      },
    });
    await expect(writeStream(join(dir, 'output'), source)).rejects.toThrow('final authentication');
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    unlink: vi.fn(actual.unlink),
  };
});
afterEach(() => vi.restoreAllMocks());

it('spools encrypted downloads beside the confined output and cleans up on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-work-'));
  try {
    const stream = new Blob(['ciphertext']).stream();
    await expect(
      withSpool(join(dir, 'output'), stream, async (source) => {
        const entries = await readdir(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^\.annon-spool-/);
        expect(await readFile(join(dir, entries[0] as string, 'encrypted'), 'utf8')).toBe(
          'ciphertext',
        );
        expect(await new Response(source.read()).text()).toBe('ciphertext');
        throw new Error('open failed');
      }),
    ).rejects.toThrow('open failed');
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('atomically links the complete file without reserving an empty requested name, then syncs the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-atomic-'));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const events: string[] = [];
  const output = join(dir, 'output');
  vi.mocked(link).mockImplementationOnce(async (temp, path) => {
    expect(path).toBe(output);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(temp, 'utf8')).toBe('complete');
    await actual.link(temp, path);
    events.push('link');
  });
  vi.mocked(unlink).mockImplementation(async (path) => {
    await actual.unlink(path);
    events.push('unlink');
  });
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      events.push(args[0] === dir ? 'directory sync' : 'file sync');
      await sync();
    });
    return handle;
  });
  try {
    await writeStream(output, new Blob(['complete']).stream());
    expect(events).toEqual(['file sync', 'link', 'unlink', 'directory sync']);
    expect(await readdir(dir)).toEqual(['output']);
    expect(await readFile(output, 'utf8')).toBe('complete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves a competing output and removes the temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-race-'));
  const output = join(dir, 'output');
  try {
    await expect(
      withOutput(output, async (sink) => {
        await new Blob(['ours']).stream().pipeTo(sink);
        await writeFile(output, 'theirs');
      }),
    ).rejects.toMatchObject({ code: 'output_exists' });
    expect(await readFile(output, 'utf8')).toBe('theirs');
    expect(await readdir(dir)).toEqual(['output']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
