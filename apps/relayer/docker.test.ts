import { expect, it } from 'vitest';
import { dockerImportProblems } from '../docker-test.ts';

it('includes every relative import reachable from server.ts and cutover.ts in the Docker context', async () => {
  expect(await dockerImportProblems(import.meta.dirname, ['server.ts', 'cutover.ts'])).toEqual([]);
});

it('imports SDK runtime code only through declared package entries', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const ts = await import('typescript');
  const { dockerAppFiles } = await import('../docker-test.ts');
  const manifest = JSON.parse(
    await readFile(new URL('../../packages/annon/package.json', import.meta.url), 'utf8'),
  );
  for (const name of await dockerAppFiles(import.meta.dirname)) {
    const source = await readFile(join(import.meta.dirname, name), 'utf8');
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      expect(fileName).not.toContain('packages/annon/src');
      if (fileName.startsWith('@defdone/annon/'))
        expect(manifest.exports).toHaveProperty(`./${fileName.slice('@defdone/annon/'.length)}`);
    }
  }
});

it('checks final-stage copies and directory exclusions', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'runtime-files-'));
  const app = join(root, 'apps/relayer');
  try {
    await mkdir(app, { recursive: true });
    await writeFile(
      join(root, '.dockerignore'),
      await readFile(new URL('../../.dockerignore', import.meta.url)),
    );
    await writeFile(join(app, 'server.ts'), "import './module.ts';");
    await writeFile(join(app, 'module.ts'), 'export {};');
    await writeFile(join(app, 'build-runtime.ts'), 'export {};');
    const build = 'FROM node AS build\nCOPY apps/relayer/*.ts apps/relayer/\nFROM node\n';
    for (const copy of [
      'COPY apps/relayer/server.ts apps/relayer/',
      'COPY --exclude=module.ts apps/relayer/ apps/relayer/',
    ]) {
      await writeFile(join(app, 'Dockerfile'), build + copy);
      expect(await dockerImportProblems(app, ['server.ts'])).toContain(
        'apps/relayer/module.ts: absent from Dockerfile COPY',
      );
    }
    await writeFile(
      join(app, 'Dockerfile'),
      build + 'COPY --exclude=build-runtime.ts apps/relayer/*.ts apps/relayer/',
    );
    expect(await dockerImportProblems(app, ['server.ts'])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
