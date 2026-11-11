import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, trustContract } from './config.js';

describe('deployment trust', () => {
  it('prompts once per network, RPC and contract, and never auto-trusts an offer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-trust-'));
    try {
      const config = await loadConfig(
        {
          command: 'status',
          contractId: 'files.near',
          nearRpc: 'https://near.example',
          baseRpc: 'https://base.example',
          stateDir: dir,
          config: join(dir, 'missing'),
        },
        {},
      );
      const prompt = vi.fn(async () => true);
      await trustContract(config, false, prompt);
      await trustContract(config, false, prompt);
      expect(prompt).toHaveBeenCalledTimes(1);
      await expect(
        trustContract({ ...config, contractId: 'other.near' }, false),
      ).rejects.toMatchObject({ code: 'trust_required', exitCode: 3 });
      await expect(
        trustContract({ ...config, nearRpc: 'https://other.example' }, false),
      ).rejects.toMatchObject({ code: 'trust_required' });
      await trustContract({ ...config, contractId: 'other.near' }, true);
      await trustContract({ ...config, contractId: 'other.near' }, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('requires human-configured RPC anchors instead of supplying implicit endpoints', async () => {
  await expect(
    loadConfig(
      {
        command: 'status',
        contractId: 'annon.near',
        config: '/private/tmp/annon-sdk-nonexistent-config.json',
      },
      {},
    ),
  ).rejects.toMatchObject({ code: 'invalid_config' });
});

it.each(['verify', 'status'] as const)(
  'allows NEAR-only %s without a Base RPC',
  async (command) => {
    expect(
      await loadConfig(
        {
          command,
          contractId: 'annon.near',
          nearRpc: 'https://near.example',
          config: '/private/tmp/annon-sdk-nonexistent-config.json',
        },
        {},
      ),
    ).toMatchObject({ nearRpc: 'https://near.example', baseRpc: '' });
  },
);
