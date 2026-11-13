/** Build the SDK runtime from the image's source context without development dependencies. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { transform } = createRequire(new URL('../../packages/annon/package.json', import.meta.url))(
  'esbuild',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'packages/annon/src');
const output = join(root, 'packages/annon/dist');
await rm(output, { recursive: true, force: true });
async function build(folder: string): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') await build(file);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const destination = join(output, relative(source, file).replace(/\.ts$/, '.js'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        (
          await transform(await readFile(file, 'utf8'), {
            loader: 'ts',
            format: 'esm',
            target: 'es2022',
            sourcefile: file,
          })
        ).code,
      );
    }
  }
}
await build(source);
