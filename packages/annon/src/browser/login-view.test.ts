import { describe, expect, it } from 'vitest';
import { type SigningRequest, signingRequest } from '../node/signing.js';
import { typedData } from '../pay/eip3009.js';
import { BASE_USDC, NEAR_USDC } from '../settle-near/terms.js';
import { clock, expiryText, formatUnits, localTime, nonceHex } from './login-format.js';
import { Refusal, walletFailure } from './login-status.js';
import { describeRequest, type Summary, technicalDetails } from './login-view.js';

const value = (s: Summary, label: string) => s.rows.find((r) => r.label === label)?.value;
const evm = `0x${'ab'.repeat(20)}`;
const payTo = `0x${'cd'.repeat(20)}`;
const nonce = Array.from({ length: 32 }, (_, i) => i);
const login = (account = '') =>
  signingRequest('near.nep413', 'near:mainnet', account, {
    message: 'Annon login: 2b7e5c1a-1111-4222-8333-444455556666 on near:mainnet',
    recipient: 'v1.annon.defdone.near',
    nonce,
  });
const usdcAuthorization = (value = 200000n) =>
  signingRequest(
    'evm.signTypedData',
    'eip155:8453',
    evm,
    typedData(BASE_USDC, {
      from: evm,
      to: payTo,
      value,
      validAfter: 0n,
      validBefore: 1794350000n,
      nonce: `0x${'11'.repeat(32)}`,
    }),
  );
const purchase = (receiverId = NEAR_USDC, amount = '1500000') =>
  signingRequest('near.signTransaction', 'near:mainnet', 'buyer.near', {
    receiverId,
    method: 'ft_transfer_call',
    args: {
      receiver_id: 'v1.annon.defdone.near',
      amount,
      msg: JSON.stringify({
        route: 'near-usdc',
        asset: receiverId,
        file_id: '0x03',
        expires_at: '1794350000',
      }),
    },
    gas: '150000000000000',
    deposit: '1',
  });

describe('request summary', () => {
  it('NEP-413 login: the account is chosen in the wallet and no key is added', () => {
    const s = describeRequest(login());
    expect(s.title).toBe('Sign in with your NEAR wallet');
    expect(value(s, 'Account')).toBe('Chosen in your wallet');
    expect(value(s, 'Recipient')).toBe('v1.annon.defdone.near');
    expect(value(s, 'Network')).toBe('NEAR mainnet (near:mainnet)');
    expect(s.message?.text).toMatch(/^Annon login: /);
    expect(s.note).toBe(
      'This proves you control the account. It adds no key and sends no transaction.',
    );
    expect(s.amount).toBeUndefined();
    expect(s.warnings).toEqual([]);
  });

  it('technical details show the NEP-413 nonce as hex, not 32 numbers', () => {
    const details = technicalDetails(login());
    expect(details).toContain(`"nonce": "0x${Buffer.from(nonce).toString('hex')}"`);
    expect(details).not.toMatch(/"nonce": \[/);
    expect(nonceHex([1, 2])).toEqual([1, 2]);
    expect(nonceHex(Array(32).fill(256))).toEqual(Array(32).fill(256));
  });

  it('names each SDK text and explains that a text signature sends no transaction', () => {
    const text = (message: string, operation: 'near.nep413' | 'evm.personalSign' = 'near.nep413') =>
      describeRequest(
        signingRequest(
          operation,
          operation === 'near.nep413' ? 'near:mainnet' : 'eip155:8453',
          '',
          {
            message,
            recipient: 'v1.annon.defdone.near',
            nonce,
          },
        ),
      );
    expect(text('Annon: list a file for sale\ncontract: x').title).toBe('Sign the listing terms');
    expect(text('Annon: list a file for sale\ncontract: x').note).toContain('sends no transaction');
    expect(text('Annon: publish a file\ncontract: x').title).toBe('Publish a file');
    expect(text('Annon: open a file again\nx').title).toBe('Open a listed file again');
    expect(text('Annon: open a purchased file again\nx').title).toBe('Open a purchased file again');
    const recovery = text('Annon: verify purchase recovery\ncontract: x\npurchase: 0x01');
    expect(recovery.title).toBe('Prove you can recover a purchase');
    expect(recovery.note).toContain('recovery identity');
    // A prefix that is not followed by a newline is not that text.
    expect(text('Annon: list a file for sale, honest').title).toBe('Sign a message');
    expect(text('Annon login: x on eip155:8453', 'evm.personalSign').title).toBe(
      'Sign in with your EVM wallet',
    );
    expect(value(text('hello', 'evm.personalSign'), 'Address')).toBe('Chosen in your wallet');
  });

  it('EIP-3009: amount, recipient and deadline come from the typed data that is signed', () => {
    const s = describeRequest(usdcAuthorization());
    expect(s.title).toBe('Approve a payment');
    expect(s.amount).toBe('0.2 USDC');
    expect(value(s, 'To')).toBe(payTo);
    expect(value(s, 'From')).toBe(evm);
    expect(value(s, 'Token')).toBe(`USDC ${BASE_USDC}`);
    expect(value(s, 'Valid until')).toBe(`${localTime(1794350000000)} local time`);
    expect(s.note).toContain('costs no gas');
    expect(s.warnings).toEqual([]);
  });

  it('typed data that is not Base USDC is shown as data, with a warning', () => {
    const q = usdcAuthorization();
    (q.payload as { domain: { verifyingContract: string } }).domain.verifyingContract = payTo;
    const s = describeRequest(q);
    expect(s.title).toBe('Sign typed data');
    expect(s.amount).toBeUndefined();
    expect(s.warnings.join(' ')).toContain('not a USDC transfer');
  });

  it('NEAR USDC payment: the amount, receiver and 1 yoctoNEAR deposit come from the transaction', () => {
    const s = describeRequest(purchase());
    expect(s.title).toBe('Approve a payment');
    expect(s.amount).toBe('1.5 USDC');
    expect(value(s, 'To')).toBe('v1.annon.defdone.near');
    expect(value(s, 'From account')).toBe('buyer.near');
    expect(value(s, 'Token')).toBe(`USDC ${NEAR_USDC}`);
    expect(value(s, 'Deposit')).toBe('1 yoctoNEAR');
    expect(value(s, 'Gas limit')).toBe('150 Tgas');
    expect(value(s, 'File')).toBe('0x03');
    expect(s.note).toContain('1 yoctoNEAR, which NEAR token transfers require');
  });

  it('an unknown token is shown in base units with a warning', () => {
    const q = purchase('token.near');
    q.payload = { ...(q.payload as object), args: { receiver_id: 'x.near', amount: '7', msg: '' } };
    const s = describeRequest(q);
    expect(s.amount).toBe('7 base units of token.near');
    expect(s.warnings.join(' ')).toContain('does not recognise this token');
  });

  it('other NEAR calls show contract, method, deposit and arguments', () => {
    const s = describeRequest(
      signingRequest('near.signTransaction', 'near:testnet', 'seller.testnet', {
        receiverId: 'annon.testnet',
        method: 'storage_deposit',
        args: {},
        gas: '30000000000000',
        deposit: '10000000000000000000000',
      }),
    );
    expect(s.title).toBe('Approve a NEAR transaction');
    expect(value(s, 'Action')).toBe('Call storage_deposit');
    expect(value(s, 'Deposit')).toBe('0.01 NEAR');
    expect(value(s, 'Gas limit')).toBe('30 Tgas');
    expect(s.message?.text).toBe('{}');
  });

  it('shows the CLI terms apart and warns when their price differs from the signed amount', () => {
    const q = purchase();
    q.terms = {
      file: '0x03',
      route: 'near',
      price: '1500000',
      recipients: [
        { identity: { kind: 'near', id: 'seller.near' }, bps: 9500 },
        { identity: { kind: 'evm', id: evm }, bps: 500 },
      ],
      remainder: 0,
    };
    const s = describeRequest(q);
    expect(s.terms).toContainEqual({ label: 'Price', value: '1.5 USDC', mono: false });
    expect(s.terms).toContainEqual({
      label: 'Recipient 1',
      value: 'NEAR seller.near 95.00%, plus the rounding remainder',
      mono: true,
    });
    expect(s.warnings).toEqual([]);
    // The terms never replace the signed amount: a different price is a warning, not the headline.
    q.terms = { ...(q.terms as object), price: '100' };
    const tampered = describeRequest(q);
    expect(tampered.amount).toBe('1.5 USDC');
    expect(value(tampered, 'Amount')).toBe('1.5 USDC');
    expect(tampered.warnings.join(' ')).toContain('Do not approve');
  });

  it('the headline amount is always the signed value, whatever the terms say', () => {
    const q = usdcAuthorization(5000000n);
    q.terms = { price: '200000', baseRecipient: evm };
    const s = describeRequest(q);
    expect(s.amount).toBe('5 USDC');
    expect(value(s, 'To')).toBe(payTo);
    expect(s.warnings.join(' ')).toContain('Do not approve');
  });

  it('keeps hostile strings as plain text values', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const q = signingRequest('near.nep413', 'near:mainnet', `${hostile}.near`, {
      message: hostile,
      recipient: `"><b>${hostile}`,
      nonce,
    });
    const s = describeRequest(q);
    expect(s.message?.text).toBe(hostile);
    expect(value(s, 'Account')).toBe(`${hostile}.near`);
    expect(value(s, 'Recipient')).toBe(`"><b>${hostile}`);
    expect(s.title).toBe('Sign a message');
  });

  it('warns about invisible or direction-changing characters in a signed text', () => {
    const s = describeRequest(
      signingRequest('evm.personalSign', 'eip155:8453', '', { message: 'pay \u202Eevil' }),
    );
    expect(s.warnings.join(' ')).toContain('invisible or direction-changing');
    expect(
      describeRequest(signingRequest('evm.personalSign', 'eip155:8453', '', { message: 'a\nb\tc' }))
        .warnings,
    ).toEqual([]);
  });

  it('describes an unknown operation as unsupported', () => {
    const q = { ...login(), operation: 'near.deleteAccount' } as unknown as SigningRequest;
    const s = describeRequest(q);
    expect(s.title).toBe('Unsupported request');
    expect(s.warnings).toEqual(['Unknown operation. Do not approve it.']);
  });
});

describe('formatting', () => {
  it('formats base units, time left and expiry', () => {
    expect(formatUnits('200000', 6)).toBe('0.2');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('0012', 2)).toBe('0.12');
    expect(formatUnits('1.5', 6)).toBe('1.5');
    expect(clock(120000)).toBe('2:00');
    expect(clock(61001)).toBe('1:02');
    expect(clock(-5)).toBe('0:00');
    expect(expiryText(1000, 1000)).toBe('Expired');
    expect(expiryText(100000, 1000)).toMatch(/^1:39 left \(until \d\d:\d\d:\d\d\)$/);
  });
});

describe('wallet failures', () => {
  it('maps wallet errors to a fixed reason and a plain message', () => {
    expect(
      walletFailure(Object.assign(new Error('User closed the window'), { endTags: [] })).reason,
    ).toBe('window_closed');
    expect(walletFailure({ message: 'x', endTags: ['WINDOW_CLOSED'] }).text).toBe(
      'The wallet window closed before signing. Try again or pick another wallet.',
    );
    expect(
      walletFailure({
        message: "Couldn't open popup window to complete wallet action",
        endTags: ['POPUP_WINDOW_OPEN_FAILED'],
      }).reason,
    ).toBe('popup_blocked');
    expect(walletFailure({ code: 4001, message: 'User rejected the request.' }).reason).toBe(
      'rejected',
    );
    expect(walletFailure('Signature invalid')).toMatchObject({ reason: 'wallet_error' });
    expect(walletFailure(new Refusal('Select eip155:8453 in your wallet.'))).toEqual({
      reason: 'refused',
      text: 'Select eip155:8453 in your wallet.',
    });
  });
});
