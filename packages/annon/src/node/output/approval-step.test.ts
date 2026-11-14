import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAdapter } from '../adapter.js';
import { type BrowserSession, startBrowserSession } from '../browser-login.js';
import { type Operation, signingRequest } from '../signing.js';
import { approvalCounter, approvalStep } from './approval-step.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const tx = (method: string) =>
  signingRequest('near.signTransaction', 'near:mainnet', 'seller.near', {
    receiverId: 'v1.annon.defdone.near',
    method,
    args: {},
    gas: '1',
    deposit: '0',
  });
const text = (operation: Operation, message: string) =>
  signingRequest(operation, 'near:mainnet', 'seller.near', {
    message,
    recipient: 'https://host.test',
    nonce: [...new Uint8Array(32)],
  });

it('names each approval by its contract method or signed text', () => {
  expect(approvalStep(text('near.nep413', 'Annon: reserve encrypted file hosting\nx'))).toBe(
    'sign the upload',
  );
  expect(approvalStep(tx('register'))).toBe('register the file on NEAR');
  expect(approvalStep(tx('storage_deposit'))).toBe('fund listing storage');
  expect(approvalStep(tx('fund_file_storage'))).toBe('fund purchase storage');
  expect(approvalStep(tx('publish_header'))).toBe('publish the file header on NEAR');
  expect(approvalStep(tx('stop_sales'))).toBe('stop sales of the file');
  expect(approvalStep(tx('odd\u001b[2J'))).toBe('send a NEAR transaction (odd [2J)');
  expect(approvalStep(text('evm.personalSign', 'Annon: list a file for sale\nx'))).toBe(
    'sign the listing terms',
  );
  expect(approvalStep(text('evm.personalSign', 'Annon: stop selling a file\nx'))).toBe(
    'stop selling a file',
  );
  expect(approvalStep(text('near.nep413', 'Annon login: x'))).toBe('sign in with your NEAR wallet');
  expect(approvalStep(text('evm.personalSign', 'hello'))).toBe('sign a message');
  const count = approvalCounter();
  expect([count(tx('register')), count(tx('publish_header'))]).toEqual([
    'Approval 1: register the file on NEAR',
    'Approval 2: publish the file header on NEAR',
  ]);
});

it('prints the approval line before the waiting line, and nothing more without one', async () => {
  for (const describe of [approvalCounter(), undefined]) {
    const notify = vi.fn();
    const s = await startBrowserSession({
      noOpen: true,
      asset: '',
      notify,
      ...(describe ? { describe } : {}),
    });
    try {
      void s.request(tx('fund_file_storage'), async () => {}).catch(() => {});
      expect(notify.mock.calls.map(([line]) => line.replace(/\d:\d\d/, 'M:SS'))).toEqual([
        ...(describe ? ['Approval 1: fund purchase storage'] : []),
        'Waiting for approval in the browser. Expires in M:SS.',
      ]);
    } finally {
      await s.close();
    }
  }
});

it('the adapter names approvals only for a person: not with --json and not without human output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-steps-'));
  try {
    for (const [human, json, named] of [
      [true, false, true],
      [true, true, false],
      [false, false, false],
    ] as const) {
      const options: Parameters<typeof startBrowserSession>[0][] = [];
      const run = createAdapter(
        {},
        {
          human,
          notify: () => {},
          browser: async (o) => {
            options.push(o);
            return {
              url: 'http://127.0.0.1:1234/#C',
              pairingCode: '1',
              close: async () => {},
              request: async () => {
                throw new Error('stop here');
              },
            } as BrowserSession;
          },
        },
      );
      await expect(
        run({ command: 'login', config: join(dir, 'config.json'), ...(json ? { json } : {}) }),
      ).rejects.toThrow('stop here');
      expect(typeof options[0]?.describe === 'function').toBe(named);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
