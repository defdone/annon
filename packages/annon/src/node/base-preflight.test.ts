import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { terms as initial, must, purchase } from '../../test/fixtures.js';
import { Annon } from '../api/annon.js';
import { parseHeader, sealWithKey } from '../envelope/pay2.js';
import * as near from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import * as splits from '../pay/split.js';
import { applySponsoredFee } from '../relay/fees.js';
import { bytes, compare, hex } from '../settle-near/codec.js';
import { encodeIdentity } from '../settle-near/identity.js';
import { termsHash } from '../settle-near/terms.js';
import { createAdapter } from './adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'disabled',
  'missing',
  'insufficient',
  'non-EVM',
  'invalid-split',
  'transport',
  'valid',
  'self-funded',
] as const)('checks Base sponsorship before any buyer signature: %s', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-preflight-'));
  try {
    const seller = privateKeyToAccount(`0x${'41'.repeat(32)}`);
    const identity = { kind: 'evm' as const, id: seller.address.toLowerCase() };
    const treasury = { kind: 'evm' as const, id: `0x${'55'.repeat(20)}` };
    const fee = { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: treasury };
    const sealed = await sealWithKey(new Uint8Array(32).fill(5), new Uint8Array([1]), {
      fileId: bytes(initial.file_id, 32),
      name: 'file',
      mime: '',
      authKind: 0,
    });
    const file = await sealed.finish({
      contractId: initial.contract,
      seller: identity,
      ckdSecret: bytes(purchase.buyer_key, 48),
      sign: (text) => seller.signMessage({ message: text }),
    });
    const terms = {
      ...initial,
      seller: identity,
      cipher_hash: hex(sealed.cipherHash),
      near: applySponsoredFee(initial.near, fee, must(initial.base).price),
    };
    if (mode === 'missing' || mode === 'self-funded') terms.near = initial.near;
    if (mode === 'insufficient')
      terms.near = {
        ...terms.near,
        recipients: [
          { identity, bps: 9999 },
          { identity: treasury, bps: 1 },
        ],
      };
    if (mode === 'non-EVM')
      terms.near = {
        ...terms.near,
        recipients: terms.near.recipients.map((r) =>
          r.identity.id !== treasury.id
            ? { ...r, identity: { kind: 'near' as const, id: 'seller.test' } }
            : r,
        ),
      };
    terms.near.recipients.sort((a, b) =>
      compare(encodeIdentity(a.identity), encodeIdentity(b.identity)),
    );
    const splitRead = vi.spyOn(splits, 'readSplitState').mockResolvedValue({
      kind: 'push',
      shares: [],
      distributorPercent: 0,
    });
    if (mode === 'invalid-split' || mode === 'self-funded')
      splitRead.mockRejectedValue(new PayError('bad_requirements', 'PRIVATE_SPLIT_DETAIL'));
    if (mode === 'transport')
      splitRead.mockRejectedValue(new PayError('transport', 'PRIVATE_RPC_DETAIL'));
    vi.spyOn(near, 'getConfig').mockResolvedValue({
      network: terms.network,
      nearUsdc: terms.near.token,
      usdc: must(terms.base).usdc,
      intents: terms.contract,
      mpc: terms.contract,
      ckdDomain: 2,
      foreignTxDomain: 3,
    });
    const config = join(dir, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        contractId: terms.contract,
        network: terms.network,
        nearRpc: 'https://near.test',
        baseRpc: 'https://base.test',
        stateDir: dir,
        trustContract: true,
        ...(mode === 'self-funded' ? {} : { relayer: 'https://relay.test' }),
      }),
    );
    const offer = {
      x402Version: 2,
      resource: { url: 'https://files.test/file' },
      accepts: [],
      extensions: {
        annon: {
          info: {
            version: 3,
            network: terms.network,
            contract: terms.contract,
            fileId: terms.file_id,
            header: 'https://files.test/header',
          },
        },
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === 'https://files.test/file')
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(offer)).toString('base64') },
        });
      if (String(url) === 'https://files.test/header')
        return new Response(file.subarray(0, parseHeader(file).headerLen));
      if (String(url) === 'https://relay.test/v1/capabilities')
        return Response.json({
          network: terms.network,
          nearUsdc: terms.near.token,
          baseUsdc: must(terms.base).usdc,
          disabled: false,
          acceptingNewBasePayments: mode !== 'disabled',
          contract: terms.contract,
          minPrice: '100000',
          methods: ['unlock'],
          fee,
          baseSponsorship: mode !== 'disabled',
        });
      if (String(url).endsWith('/v1/base-eligibility'))
        return Response.json({
          network: terms.network,
          contract: terms.contract,
          fileId: terms.file_id,
          termsHash: termsHash(terms),
          eligible: true,
          tier: 'legacy',
          policyVersion: '1',
          minPrice: '100000',
          fee,
          decidedAt: 1,
          checkedAt: Math.floor(Date.now() / 1000),
        });
      throw new Error('Unexpected network access');
    });
    vi.stubGlobal('fetch', fetcher);
    const sign = vi.fn();
    const buy = vi.fn(async () => {
      throw new Error('PAYMENT_REACHED');
    });
    const prompt = vi.fn(async () => true);
    const adapter = createAdapter(
      { ANNON_CONFIG: config, ANNON_BACKUP_SECRET: '01'.repeat(32) },
      {
        fetch: fetcher,
        prompt,
        wallet: async () => ({ identity, authorize: sign, signTypedData: sign }),
        file: async () => ({
          terms,
          termsHash: termsHash(terms),
          seller: identity,
          cipherHash: terms.cipher_hash,
          price: BigInt(terms.near.price),
          payTo: must(terms.base).pay_to,
          purchaseStorageBalance: 0n,
          moderator: null,
          headerHash: null,
          salesStoppedAt: null,
          takenDown: null,
        }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'buy').mockImplementation(buy);
          return sdk;
        },
      },
    );
    const result = adapter({ command: 'buy', target: 'https://files.test/file', maxPrice: '1' });
    if (mode === 'valid') {
      await expect(result).rejects.toThrow('PAYMENT_REACHED');
      expect(buy).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toMatchObject({
        code:
          mode === 'self-funded'
            ? 'transport_required'
            : ['transport', 'disabled'].includes(mode)
              ? 'relayer_unavailable'
              : 'not_sponsored',
      });
      expect(buy).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    }
    expect(sign).not.toHaveBeenCalled();
    if (['valid', 'invalid-split', 'transport'].includes(mode))
      expect(splitRead).toHaveBeenCalledWith('https://base.test', must(terms.base).pay_to, {
        recipients: terms.near.recipients.map((r) => r.identity.id),
        allocations: terms.near.recipients.map((r) => BigInt(r.bps)),
        totalAllocation: 10000n,
        distributionIncentive: 0,
      });
    else expect(splitRead).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
