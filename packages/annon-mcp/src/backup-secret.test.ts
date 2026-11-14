import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdapter } from '../../annon/src/node/adapter.js';
import { defaultBackupSecretPath } from '../../annon/src/node/backup-secret.js';
import { initBackupSecret } from '../../annon/src/node/backup-secret-init.js';
import { createServer } from './server.js';

const purchaseId = `0x${'77'.repeat(32)}`;
const work = () => join(homedir(), 'work');

/** A forced-agent MCP server on the pinned home config, as the launcher runs it. */
async function agentServer() {
  const config = join(homedir(), '.config', 'annon', 'config.json');
  await mkdir(dirname(config), { recursive: true });
  await mkdir(work(), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      stateDir: work(),
      workDir: work(),
      trustContract: true,
      maxPrice: '1',
      dailyBudget: '1',
    }),
  );
  const wallet = vi.fn();
  const sdk = vi.fn();
  const server = createServer(
    createAdapter({}, { agent: true, wallet, sdk, purchase: async () => null }),
  );
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `annon_${name}`, arguments: args });
  return { client, call, wallet, sdk, close: () => client.close().then(() => server.close()) };
}
afterEach(async () => {
  for (const dir of ['.config', 'work'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

it('has no setup or export tool and no tool accepts a backup secret input', async () => {
  const s = await agentServer();
  try {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /init|login|secret|export/.test(n))).toEqual([]);
    for (const tool of tools)
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('backupSecretFile');
  } finally {
    await s.close();
  }
});

it('MCP calls without a secret report pending or fail, and never create one', async () => {
  const s = await agentServer();
  try {
    expect((await s.call('status', { target: purchaseId })).structuredContent).toMatchObject({
      ok: true,
      result: { state: 'pending' },
    });
    for (const [name, args] of [
      ['recover', { recovery: 'near:buyer.near' }],
      ['open', { target: purchaseId, output: 'out' }],
    ] as const) {
      const r = await s.call(name, args);
      expect(r.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'backup_secret_required' },
      });
    }
    expect(s.wallet).not.toHaveBeenCalled();
    expect(s.sdk).not.toHaveBeenCalled();
    await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await s.close();
  }
});

it('reads an operator-provisioned default without ever returning it', async () => {
  await initBackupSecret({}, {});
  const secret = (await readFile(defaultBackupSecretPath(), 'utf8')).trim();
  const s = await agentServer();
  s.sdk.mockImplementation(() => {
    throw new Error(`sdk failed ${secret}`);
  });
  try {
    const results = [
      await s.call('status', { target: purchaseId }),
      await s.call('recover', { recovery: 'near:buyer.near' }),
    ];
    // The default was read: the calls reached the SDK, which needs the secret.
    expect(s.sdk).toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain(secret);
    expect(JSON.stringify(results)).not.toContain(secret.slice(0, 32));
  } finally {
    await s.close();
  }
});
