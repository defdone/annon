import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sample: vi.fn(async () => {}),
  selfCheck: vi.fn(async () => true),
  alert: vi.fn(async () => {}),
}));
vi.mock('./facilitator.ts', async (load) => ({
  ...(await load<typeof import('./facilitator.ts')>()),
  baseFacilitator: async () =>
    Object.assign(vi.fn(), { sample: mocks.sample, selfCheck: mocks.selfCheck }),
}));
vi.mock('./alerts.ts', async (load) => ({
  ...(await load<typeof import('./alerts.ts')>()),
  hostAlerts: () => mocks.alert,
}));

import { main, reportStartupFailure } from './server.ts';

async function config() {
  const root = await mkdtemp(join(tmpdir(), 'host-boot-probe-'));
  const data = join(root, 'data');
  const files = join(root, 'files');
  await mkdir(files);
  await writeFile(join(files, 'files.json'), '[]');
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((r) => socket.close(() => r()));
  return {
    root,
    data,
    files,
    env: {
      PORT: String(address.port),
      DATA_DIR: data,
      FILES_DIR: files,
      PUBLIC_URL: 'https://demo.example',
      RELAYER_ORIGIN: 'https://relay.example',
      SELLERS: `evm:0x${'11'.repeat(20)}`,
      CANONICAL_DEMO_FILE_ID: `0x${'22'.repeat(32)}`,
      DEMO_ALERT_WEBHOOK: 'https://hooks.slack.com/services/example',
      BASE_RPC: 'https://base.invalid',
      NEAR_RPC: 'https://near.invalid',
      CONTRACT_ID: 'market.near',
    },
  };
}
it('probes legacy migration, seeded restart, key activation and recovery after first boot failure', async () => {
  const c = await config();
  try {
    await mkdir(join(c.data, 'seller'), { recursive: true });
    await writeFile(join(c.data, 'seller', 'evidence.json'), '{}');
    await writeFile(join(c.files, 'files.json'), 'invalid');
    await expect(main(c.env)).rejects.toThrow();
    expect(await readFile(join(c.data, '.host-ready'), 'utf8')).toBe('1');
    expect(await readFile(join(c.data, 'seller', 'evidence.json'), 'utf8')).toBe('{}');
    await writeFile(join(c.files, 'files.json'), '[]');
    const first = await main(c.env);
    await first.close();
    mocks.sample.mockRejectedValueOnce(new Error('private RPC detail'));
    const second = await main({ ...c.env, FACILITATOR_KEY: '42'.repeat(32) });
    await vi.waitFor(() =>
      expect(mocks.alert).toHaveBeenCalledWith({ type: 'base_rpc_unhealthy' }),
    );
    expect((await fetch(`http://127.0.0.1:${c.env.PORT}/healthz`)).status).toBe(200);
    await second.close();
    const third = await main({ ...c.env, FACILITATOR_KEY: '42'.repeat(32) });
    await third.close();
  } finally {
    await rm(c.root, { recursive: true, force: true });
  }
});
it('awaits the override self-check in background and keeps facilitator disabled until it succeeds', async () => {
  const c = await config();
  let release!: (value: boolean) => void;
  mocks.selfCheck.mockImplementationOnce(
    () =>
      new Promise<boolean>((r) => {
        release = r;
      }),
  );
  try {
    const host = await main({ ...c.env, FACILITATOR_KEY: '42'.repeat(32) });
    expect((await fetch(`http://127.0.0.1:${c.env.PORT}/healthz`)).status).toBe(200);
    release(false);
    await host.close();
  } finally {
    await rm(c.root, { recursive: true, force: true });
  }
});
it('logs and delivers only whitelisted startup reasons before returning', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await reportStartupFailure(new Error('private diagnostic'), {
      DEMO_ALERT_WEBHOOK: 'https://hooks.slack.com/services/example',
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ error: 'host_startup_failed', reason: 'config_invalid' }),
    );
    expect(mocks.alert).toHaveBeenCalledWith({
      type: 'host_startup_failed',
      reason: 'config_invalid',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});

it('refuses manually seeded missing state and reports the safe missing-state reason', async () => {
  const c = await config();
  try {
    await mkdir(c.data);
    for (const area of ['seller', 'downloads', 'capacity', 'facilitator'])
      await mkdir(join(c.data, area));
    await writeFile(join(c.data, '.host-ready'), '1');
    await expect(main(c.env)).rejects.toMatchObject({ reason: 'state_missing' });
  } finally {
    await rm(c.root, { recursive: true, force: true });
  }
});

it('fails closed with a missing-state reason if initialized capacity is removed', async () => {
  const c = await config();
  try {
    const first = await main(c.env);
    await first.close();
    await rm(join(c.data, 'capacity'), { recursive: true });
    await mkdir(join(c.data, 'capacity'));
    await expect(main(c.env)).rejects.toMatchObject({ reason: 'state_missing' });
  } finally {
    await rm(c.root, { recursive: true, force: true });
  }
});
