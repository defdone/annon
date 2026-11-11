import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: processBoundary.spawn,
}));

vi.mock('near-api-js', async (original) => ({
  ...(await original<typeof import('near-api-js')>()),
  KeyPair: {
    fromRandom: () => ({
      toString: () => 'ed25519:fake-test-only',
      getPublicKey: () => ({ toString: () => 'ed25519:fake-public-only' }),
    }),
  },
}));

it('creates with an empty trusted-app ACL over stdin, using a fake security process', async () => {
  const { osKeychain } = await import('./keychain.js');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
  });
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += String(chunk);
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  processBoundary.spawn.mockReturnValue(child);
  try {
    await osKeychain.create('near', 'fake-test', 'fake.testnet');
    expect(processBoundary.spawn).toHaveBeenCalledWith('/usr/bin/security', ['-i'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    expect(input).toMatch(/ -T ""(?: |\n)/);
    expect(input).not.toContain('ed25519:');
  } finally {
    vi.restoreAllMocks();
  }
});
