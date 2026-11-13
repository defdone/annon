import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerAppFiles, dockerImageFiles, dockerImportProblems } from '../docker-test.ts';

it('includes every relative import reachable from server.ts in the Docker context', async () => {
  expect(await dockerImportProblems(import.meta.dirname, ['server.ts'])).toEqual([]);
});

describe.runIf(process.env.ANNON_TEST_CONTAINER === '1')(
  'isolated production container dependencies',
  () => {
    it('starts after the Docker prod-filter install and has no development dependencies', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'annon-host-prod-install-'));
      const root = join(import.meta.dirname, '../..');
      try {
        for (const folder of [
          'packages/annon',
          'packages/annon-mcp',
          'apps/relayer',
          'apps/demo-host',
        ])
          await mkdir(join(dir, folder), { recursive: true });
        for (const file of [
          'package.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'packages/annon/package.json',
          'packages/annon-mcp/package.json',
          'apps/relayer/package.json',
          'apps/demo-host/package.json',
        ])
          await cp(join(root, file), join(dir, file));
        for (const name of await dockerAppFiles(import.meta.dirname))
          await cp(join(import.meta.dirname, name), join(dir, 'apps/demo-host', name));
        await cp(join(root, 'packages/annon/src'), join(dir, 'packages/annon/src'), {
          recursive: true,
          filter: (file) => !file.endsWith('.test.ts'),
        });
        const install = spawnSync(
          'pnpm',
          [
            'install',
            '--frozen-lockfile',
            '--prod',
            '--filter',
            '@defdone/annon',
            '--filter',
            '@defdone/annon-demo-host',
            '--store-dir',
            join(dir, 'store'),
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 120000,
            env: { PATH: process.env.PATH, CI: 'true', npm_config_cache: join(dir, 'npm-cache') },
          },
        );
        expect(install.status, install.stdout + install.stderr).toBe(0);
        const app = join(dir, 'apps/demo-host');
        const noDev = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "try { import.meta.resolve('vitest'); process.exit(1); } catch { process.exit(0); }",
          ],
          { cwd: app, encoding: 'utf8' },
        );
        expect(noDev.status).toBe(0);
        const start = () =>
          spawnSync(process.execPath, ['--no-warnings', '--import', './ts-hook.mjs', 'server.ts'], {
            cwd: app,
            encoding: 'utf8',
            timeout: 10000,
            env: { PATH: process.env.PATH },
          });
        const out = start();
        expect(out.status).toBe(1);
        expect(out.stderr.trim()).toBe(
          JSON.stringify({ error: 'host_startup_failed', reason: 'config_invalid' }),
        );
        expect(out.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
        await appendFile(join(app, 'server.ts'), "\nimport 'vitest';\n");
        expect(start().stderr).toContain('ERR_MODULE_NOT_FOUND');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 180000);
  },
);

it('excludes the relayer build helper from the final image', async () => {
  const files = await dockerImageFiles(join(import.meta.dirname, '../relayer'));
  expect(files).toContain('apps/relayer/cutover-scan.ts');
  expect(files).not.toContain('apps/relayer/build-runtime.ts');
});

it('models directory-relative BuildKit exclusions without basename rules or name skips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docker-copy-'));
  const app = join(root, 'apps/demo-host');
  try {
    await mkdir(join(app, 'nested'), { recursive: true });
    await writeFile(join(root, '.dockerignore'), '**/*.test.ts\n');
    await writeFile(join(app, 'server.ts'), "import './nested/module.ts';");
    await writeFile(join(app, 'nested/module.ts'), 'export {};');
    await writeFile(join(app, 'build-runtime.ts'), 'export {};');
    const prefix = 'FROM node AS build\nCOPY apps/demo-host/ apps/demo-host/\nFROM node\n';
    for (const [copy, missing] of [
      ['COPY apps/demo-host/server.ts apps/demo-host/', true],
      ['COPY --exclude=nested/module.ts apps/demo-host/ apps/demo-host/', true],
      ['COPY --exclude=module.ts apps/demo-host/ apps/demo-host/', false],
      ['COPY --exclude=apps/demo-host/nested/module.ts apps/demo-host/ apps/demo-host/', false],
      [
        'COPY --exclude=module.ts apps/demo-host/nested/*.ts apps/demo-host/nested/\nCOPY apps/demo-host/server.ts apps/demo-host/',
        false,
      ],
      [
        'COPY --exclude=build-runtime.ts apps/demo-host/*.ts apps/demo-host/\nCOPY apps/demo-host/nested/ apps/demo-host/nested/',
        false,
      ],
      ['COPY --exclude=build-runtime.ts apps/demo-host/ apps/demo-host/', false],
    ] as const) {
      await writeFile(join(app, 'Dockerfile'), prefix + copy);
      const problems = await dockerImportProblems(app, ['server.ts']);
      expect(
        problems.includes('apps/demo-host/nested/module.ts: absent from Dockerfile COPY'),
        copy,
      ).toBe(missing);
    }
    expect(await dockerImageFiles(app)).not.toContain('apps/demo-host/build-runtime.ts');
    await writeFile(
      join(app, 'Dockerfile'),
      `${prefix}COPY --exclude=build-runtime.ts apps/demo-host/*.ts apps/demo-host/`,
    );
    expect(await dockerImageFiles(app)).toContain('apps/demo-host/build-runtime.ts');
    await writeFile(
      join(app, 'Dockerfile'),
      `${prefix}COPY --exclude=**/*.ts apps/demo-host/*.ts apps/demo-host/`,
    );
    expect(await dockerImageFiles(app)).toContain('apps/demo-host/server.ts');
    await writeFile(join(app, 'server.ts'), "import './build-runtime.ts';");
    await writeFile(
      join(app, 'Dockerfile'),
      `${prefix}COPY --exclude=build-runtime.ts apps/demo-host/ apps/demo-host/`,
    );
    expect(await dockerImportProblems(app, ['server.ts'])).toContain(
      'apps/demo-host/build-runtime.ts: absent from Dockerfile COPY',
    );
    expect(await readFile(join(app, 'build-runtime.ts'), 'utf8')).toBe('export {};');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
