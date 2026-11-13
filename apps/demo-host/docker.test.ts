import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerAppFiles, dockerImportProblems } from '../docker-test.ts';

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
