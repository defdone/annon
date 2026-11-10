import {
  buildSIWxSchema,
  createSIWxMessage,
  createSIWxPayload,
  encodeSIWxHeader,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from '@x402/extensions/sign-in-with-x';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  fileUrn,
  readSignIn,
  SIGN_IN_SCHEMA,
  type SignInChallenge,
  signInChallenge,
  signInExtension,
  signInHeader,
  signInMessage,
  verifySignIn,
} from './siwx.js';

const URL1 = 'https://seller.example/f/1';
const FILE = {
  contractId: 'v1.annon.defdone.near',
  fileId: `0x${'11'.repeat(32)}`,
  headerHash: `0x${'22'.repeat(32)}`,
};
const NOW = 1_800_000_000;
const buyer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const sign = async (c: SignInChallenge, who = buyer) =>
  signInHeader(c, who.address, await who.signMessage({ message: signInMessage(c, who.address) }));

describe('sign-in-with-x as x402 defines it', () => {
  it('builds the challenge download.md section 2 lists, with a fresh 32-hex nonce', () => {
    const c = signInChallenge(URL1, FILE, NOW);
    expect(c).toMatchObject({
      domain: 'seller.example',
      uri: URL1,
      version: '1',
      statement: 'Download an Annon file you bought.',
      issuedAt: new Date(NOW * 1000).toISOString(),
      expirationTime: new Date((NOW + 300) * 1000).toISOString(),
      resources: [fileUrn(FILE.contractId, FILE.fileId, FILE.headerHash)],
    });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(signInChallenge(URL1, FILE, NOW).nonce).not.toBe(c.nonce);
  });

  it('declares the schema x402 builds, and builds the message x402 builds, byte for byte', () => {
    expect(SIGN_IN_SCHEMA).toEqual(buildSIWxSchema());
    const c = signInChallenge('https://files.example:8443/a/b?x=1', FILE, NOW);
    for (const a of [buyer.address, buyer.address.toLowerCase(), other.address]) {
      expect(signInMessage(c, a)).toBe(
        createSIWxMessage({ ...c, chainId: 'eip155:8453', type: 'eip191' } as never, a),
      );
    }
    expect(signInExtension(c).supportedChains).toEqual([
      { chainId: 'eip155:8453', type: 'eip191' },
    ]);
  });

  it("takes a proof made by x402's own client", async () => {
    const c = signInChallenge(URL1, FILE, NOW);
    const payload = await createSIWxPayload(
      { ...c, chainId: 'eip155:8453', type: 'eip191' } as never,
      buyer as never,
      URL1,
    );
    const proof = readSignIn(encodeSIWxHeader(payload));
    expect(proof).not.toBeNull();
    expect(verifySignIn(proof as never, c, NOW + 10)).toBe(buyer.address.toLowerCase());
  });

  it("makes a proof x402's own server code accepts", async () => {
    const c = signInChallenge(URL1, FILE, Math.floor(Date.now() / 1000));
    const parsed = parseSIWxHeader(await sign(c));
    expect(await validateSIWxMessage(parsed, new URL(URL1))).toEqual({ isValid: true });
    expect(await verifySIWxSignature(parsed)).toEqual({ isValid: true, payer: buyer.address });
  });

  it('refuses another challenge, another wallet, a changed field, the wrong time, another chain', async () => {
    const c = signInChallenge(URL1, FILE, NOW);
    const proof = readSignIn(await sign(c)) as NonNullable<ReturnType<typeof readSignIn>>;
    expect(verifySignIn(proof, c, NOW + 1)).toBe(buyer.address.toLowerCase());
    const otherC = signInChallenge(URL1, FILE, NOW);
    expect(verifySignIn(proof, otherC, NOW + 1)).toBeNull();
    for (const change of [
      { domain: 'evil.example' },
      { uri: 'https://seller.example/f/2' },
      { statement: 'Something else.' },
      { resources: [fileUrn(FILE.contractId, `0x${'12'.repeat(32)}`, FILE.headerHash)] },
      { chainId: 'eip155:1' },
      { type: 'ed25519' },
      { address: other.address },
      { signature: `0x${'11'.repeat(65)}` },
    ]) {
      expect(verifySignIn({ ...proof, ...change }, c, NOW + 1), JSON.stringify(change)).toBeNull();
    }
    // Before it was issued, at its expiry, and later.
    expect(verifySignIn(proof, c, NOW - 1)).toBeNull();
    expect(verifySignIn(proof, c, NOW + 300)).toBeNull();
    // Another wallet's signature over the buyer's claim.
    const forged = readSignIn(
      signInHeader(
        c,
        buyer.address,
        await other.signMessage({ message: signInMessage(c, buyer.address) }),
      ),
    ) as NonNullable<ReturnType<typeof readSignIn>>;
    expect(verifySignIn(forged, c, NOW + 1)).toBeNull();
  });

  it('reads nothing that is not a proof', () => {
    for (const h of [
      undefined,
      '',
      'not base64!',
      btoa('{}'),
      btoa('[1]'),
      btoa('{"resources":"x"}'),
    ]) {
      expect(readSignIn(h)).toBeNull();
    }
  });
});
