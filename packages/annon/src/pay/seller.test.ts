import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { purchase as sample, terms } from '../../test/fixtures.js';
import { baseNonceV2, purchaseId } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { typedData } from './eip3009.js';
import { paymentRequired, verifyPayment } from './seller.js';
import { paymentSignature } from './x402.js';

afterEach(() => vi.unstubAllGlobals());
it('uses Base time to refuse a short authorization before accepting a payment', async () => {
  const time = Math.floor(Date.now() / 1000);
  const payer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const file = {
    terms,
    termsHash: termsHash(terms),
    price: BigInt(sample.price),
    payTo: terms.base?.pay_to,
    salesStoppedAt: null,
    takenDown: null,
  };
  const options = {
    nearRpc: 'https://near.invalid',
    baseRpc: 'https://base.invalid',
    contractId: terms.contract,
    fileId: terms.file_id,
    url: 'https://example.com/file',
    header: 'https://example.com/header',
  };
  const pr = paymentRequired(options, file as never, sample.asset);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const r = JSON.parse(init.body);
      const value =
        url === options.nearRpc
          ? {
              result: [
                ...new TextEncoder().encode(
                  JSON.stringify(
                    r.params.method_name === 'get_file'
                      ? {
                          terms,
                          terms_hash: termsHash(terms),
                          sales_stopped_at: null,
                          taken_down: null,
                          header_hash: null,
                        }
                      : {
                          network: terms.network,
                          near_usdc: terms.near.token,
                          usdc: sample.asset,
                          intents: 'intents.near',
                          mpc: 'v1.signer',
                          ckd_domain: 2,
                          foreign_tx_domain: 3,
                        },
                  ),
                ),
              ],
            }
          : r.method === 'eth_chainId'
            ? '0x2105'
            : r.method === 'eth_getBlockByNumber'
              ? { number: '0x1', timestamp: `0x${(time + 5).toString(16)}` }
              : '0x';
      return { json: async () => ({ id: r.id, result: value }) };
    }),
  );
  for (const seconds of [59, 60]) {
    const purchase = { ...sample, terms_hash: termsHash(terms), expires_at: String(time + 180) };
    const a = {
      from: payer.address.toLowerCase(),
      to: pr.accepts[1]?.payTo as string,
      value: BigInt(sample.price),
      validAfter: 0n,
      validBefore: BigInt(time + 5 + seconds),
      nonce: baseNonceV2(purchaseId(purchase)),
    };
    const signature = await payer.signTypedData(typedData(sample.asset, a) as never);
    const header = paymentSignature(pr, pr.accepts[1] as never, a, signature, purchase);
    if (seconds === 59)
      await expect(verifyPayment(header, options)).rejects.toMatchObject({
        code: 'payment_expired',
      });
    else
      await expect(verifyPayment(header, options)).resolves.toMatchObject({
        validBefore: a.validBefore,
      });
  }
});
