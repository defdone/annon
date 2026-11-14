import { expect, it } from 'vitest';
import { terms } from '../../../test/fixtures.js';
import { localTime } from '../../browser/login-format.js';
import { termsHash } from '../../settle-near/terms.js';
import { runCli } from '../cli.js';
import { AdapterError } from '../errors.js';

const id = `0x${'ab'.repeat(32)}`;
const manifest = 'https://shop.test/.well-known/annon-shop.json';
const entry = (title: string, extra: Record<string, unknown> = {}) => ({
  name: 'file.bin',
  fileId: terms.file_id,
  title,
  description: '',
  url: 'https://files.test/f/one',
  header: 'https://files.test/f/one/header',
  byteSize: 10,
  plaintextSize: 5,
  createdAt: 1790000000,
  expiresAt: 1800000000,
  termsHash: termsHash(terms),
  terms,
  salesStopped: false,
  takenDown: false,
  ...extra,
});
const shopInfo = { name: 'Demo Shop', shopUrl: 'https://shop.test/demo', rules: { text: 'T' } };
const payment = { amountUsdc: '0.2', route: 'near' };
const deposit = {
  address: 'deposit-address',
  amount: '200000',
  asset: 'nep141:base-usdc.synthetic.near',
  chain: 'base',
  memo: 'memo-1',
  qrData: 'q',
  depositBefore: '2026-11-14T12:00:00.000Z',
  purchaseExpiresAt: '2026-11-14T12:10:00.000Z',
};
const bought = {
  purchaseId: id,
  fileId: terms.file_id,
  route: 'near',
  payment,
  backup: '/s/b.json',
};

/** One command line through runCli in human mode and in --json mode, against a scripted adapter. */
async function both(argv: string[], result: unknown) {
  const run = async (args: string[], human: boolean) => {
    const lines: string[] = [];
    const exit = await runCli(
      args,
      async () => result,
      (line) => lines.push(line),
      {
        human,
        wait: async () => {},
      },
    );
    return { exit, text: lines.join('\n') };
  };
  const human = await run(argv, true);
  const json = await run([...argv, '--json'], true);
  // --json is one compact envelope with the adapter's result untouched, whatever the terminal is.
  expect(json.text).toBe(JSON.stringify({ ok: true, result }));
  expect(json.exit).toBe(human.exit);
  // Without a terminal (human off) the pretty envelope scripts read today is still the last output.
  const piped = await run(argv, false);
  expect(piped.text.endsWith(JSON.stringify({ ok: true, result }, null, 2))).toBe(true);
  return human;
}

it('login, shops and shop add read as short lines', async () => {
  expect(
    (
      await both(['login'], {
        identity: { kind: 'near', id: 'alice.near' },
        network: 'near:mainnet',
        mode: 'browser',
      })
    ).text,
  ).toBe('Signed in as alice.near on NEAR mainnet.');
  expect(
    (
      await both(['shops'], {
        items: [
          { manifest, id: 'demo', info: shopInfo, trusted: true },
          {
            manifest: 'https://down.test/.well-known/annon-shop.json',
            trusted: false,
            error: 'unavailable',
          },
        ],
        total: 2,
        nextOffset: null,
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "Shops (2):
     demo  Demo Shop                  https://shop.test/demo                         trusted profile
     -     unavailable (unavailable)  https://down.test/.well-known/annon-shop.json"
  `);
  expect(
    (await both(['shops'], { items: [], total: 0, nextOffset: null })).text,
  ).toMatchInlineSnapshot(
    `"No shops configured. Add one with: annon shop add <shop url> --id <name>"`,
  );
  expect(
    (
      await both(['shop', 'add', 'https://shop.test/demo', '--id', 'demo'], {
        manifest,
        id: 'demo',
        trusted: false,
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "Shop added as demo: https://shop.test/.well-known/annon-shop.json
    List its files with: annon catalog --shop demo"
  `);
});

it('catalog is a numbered table with the shop rules in one line', async () => {
  const page = {
    items: [
      entry('Quarterly report'),
      entry('Old notes', { salesStopped: true, expiresAt: null, terms: { ...terms, base: null } }),
    ],
    total: 12,
    nextOffset: 7,
    shop: { manifest, name: 'Demo Shop' },
    rules: { text: 'Be kind.\nNo malware.  Files are removed after 30 days.' },
  };
  expect(
    (await both(['catalog', '--shop', 'demo', '--offset', '5', '--limit', '2'], page)).text,
  ).toMatchInlineSnapshot(`
    "Files 6 to 7 of 12:
     #  Title             Price     Routes              Seller             Expires
     6  Quarterly report  0.2 USDC  near, base, 1click  evm:0x1111...1111  2027-01-15
     7  Old notes         0.2 USDC  sales stopped       evm:0x1111...1111  -
    Shop rules (Demo Shop): Be kind. No malware. Files are removed after 30 days.
    More: add --offset 7
    Buy a row with: annon buy <#> --shop demo"
  `);
  expect((await both(['catalog'], { items: [], total: 0, nextOffset: null })).text).toBe(
    'No files.',
  );
});

it('remote text cannot write terminal escapes or reorder the line', async () => {
  const { text } = await both(['catalog'], {
    items: [entry(`\u001b[2Jwipe${String.fromCharCode(0x202e)}gnp.exe\r\nfake row`)],
    total: 1,
    nextOffset: null,
    shop: { manifest, name: 'Shop\u001b]0;title\u0007' },
    rules: { text: 'rule\u001b[31m' },
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
  expect(text.replaceAll('\n', '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
  expect(text).toContain(' [2Jwipegnp.exe  fake row');
});

it('buy shows the next step for each outcome and never drops the purchase ID', async () => {
  const submitted = { ...bought, state: 'submitted', next: 'n' };
  expect(
    (
      await both(['buy', 'https://files.test/f/one'], {
        ...bought,
        state: 'opened',
        opened: { output: 'report.pdf', bytes: 12 },
        next: 'The file is saved.',
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab (0.2 USDC, near route)
    Accepted by NEAR. Saved report.pdf (12 bytes).
    Backup: /s/b.json"
  `);
  expect(
    (await both(['buy', 'https://files.test/f/one'], { ...bought, state: 'accepted', next: 'x' }))
      .text,
  ).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab (0.2 USDC, near route)
    Accepted by NEAR.
    Save the file with: annon open --output <file>
    Backup: /s/b.json"
  `);
  const oneClick = await both(['buy', 'https://files.test/f/one'], {
    ...bought,
    route: '1click',
    payment: { amountUsdc: '0.2', route: '1click' },
    state: 'deposit_required',
    instructions: deposit,
    source: {
      chain: 'base',
      asset: deposit.asset,
      amount: '200000',
      amountFormatted: '0.2',
      symbol: 'USDC',
      depositBefore: deposit.depositBefore,
    },
    next: 'Fund the deposit as instructed, then check status and open this purchase.',
  });
  expect(oneClick.exit).toBe(0);
  expect(oneClick.text).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab (0.2 USDC, 1click route)
    Send this deposit from your own wallet:
      Amount  0.2 USDC (200000 base units)
      Asset   nep141:base-usdc.synthetic.near
      Chain   base
      To      deposit-address
      Memo    memo-1 (required)
      Before  2026-11-14T12:00:00.000Z
    Fund the deposit as instructed, then check status and open this purchase.
    Then: annon status, and annon open --output <file> (both use this purchase).
    Backup: /s/b.json"
  `);
  const uncertain = await both(['buy', 'https://files.test/f/one'], {
    ...bought,
    state: 'uncertain',
    txHash: 'synthetic-hash',
    settlement: 'pending',
    next: `Not accepted yet. Do not pay again. Run annon status ${id} until it is accepted, then annon open ${id} --output <file>.`,
  });
  expect(uncertain.exit).toBe(4);
  expect(uncertain.text).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab (0.2 USDC, near route)
    Transaction: synthetic-hash
    Not accepted yet. Do not pay again. Run annon status 0xabababababababababababababababababababababababababababababababab until it is accepted, then annon open 0xabababababababababababababababababababababababababababababababab --output <file>.
    Backup: /s/b.json"
  `);
  const pending = await both(['buy', 'https://files.test/f/one'], {
    ...submitted,
    settlement: 'pending',
  });
  expect(pending.exit).toBe(4);
  const failedOpen = await both(['buy', 'https://files.test/f/one'], {
    ...bought,
    state: 'accepted',
    next: 'x',
    openError: { code: 'unavailable', message: 'The host is unavailable.', exitCode: 1 },
  });
  expect(failedOpen.exit).toBe(1);
  expect(failedOpen.text).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab (0.2 USDC, near route)
    Accepted by NEAR, but the file was not saved: The host is unavailable. (unavailable)
    The purchase is kept. Retry with: annon open --output <file>
    Backup: /s/b.json"
  `);
  const failedStatus = await both(['buy', 'https://files.test/f/one'], {
    ...submitted,
    settlement: 'pending',
    statusError: { code: 'unavailable', message: 'RPC down.', exitCode: 1 },
  });
  expect(failedStatus.exit).toBe(1);
  expect(failedStatus.text).toContain(`Purchase ${id}`);
  expect(failedStatus.text).toContain('Status check failed: RPC down. (unavailable)');
});

it('status, open, verify and recover are one or two lines; other commands list their fields', async () => {
  expect(
    (await both(['status', id], { purchaseId: id, state: 'accepted', next: 'open' })).text,
  ).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab is accepted.
    Save the file with: annon open 0xabababababababababababababababababababababababababababababababab --output <file>"
  `);
  const pending = await both(['status'], {
    purchaseId: id,
    state: 'pending',
    submission: 'uncertain',
    txHash: 'synthetic-hash',
    retryAfterSeconds: 30,
    next: 'The wallet may have sent this payment. Do not pay again. Retry status until it is accepted or the purchase expires.',
  });
  expect(pending.exit).toBe(4);
  expect(pending.text).toMatchInlineSnapshot(`
    "Purchase 0xabababababababababababababababababababababababababababababababab is pending (the payment may have been sent).
    Transaction: synthetic-hash
    The wallet may have sent this payment. Do not pay again. Retry status until it is accepted or the purchase expires.
    Check again in 30 seconds."
  `);
  expect(
    (
      await both(['open', '--output', 'report.pdf'], {
        fileId: terms.file_id,
        purchaseId: id,
        output: 'report.pdf',
        bytes: 12,
      })
    ).text,
  ).toMatchInlineSnapshot(
    `"Saved report.pdf (12 bytes) from purchase 0xabababababababababababababababababababababababababababababababab."`,
  );
  expect(
    (
      await both(['verify', 'a.pay2'], {
        fileId: terms.file_id,
        verified: true,
        checked: 'header-and-body',
        contractId: 'annon.near',
      })
    ).text,
  ).toMatchInlineSnapshot(
    `"Verified file 0x2222222222222222222222222222222222222222222222222222222222222222 (header-and-body) against annon.near."`,
  );
  expect(
    (
      await both(['recover', '--recovery', 'near:buyer.near'], {
        errors: [
          { purchaseId: `0x${'cd'.repeat(32)}`, code: 'unavailable', message: 'Try later.' },
        ],
        recovered: [{ purchaseId: id, fileId: terms.file_id, grant: 0, backup: '/s/r.json' }],
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "Recovered purchases (1):
      0xabababababababababababababababababababababababababababababababab  file 0x2222222222222222222222222222222222222222222222222222222222222222
        backup: /s/r.json
      0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd  failed: Try later. (unavailable)
    Open one with: annon open <purchase id> --output <file>"
  `);
  expect(
    (
      await both(['budget', terms.file_id], {
        fileId: terms.file_id,
        available: '1',
        nested: { a: 1 },
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "fileId: 0x2222222222222222222222222222222222222222222222222222222222222222
    available: 1
    nested: {"a":1}"
  `);
  expect(
    (
      await both(['share', 'a.txt', '--price', '0.1'], {
        fileId: terms.file_id,
        url: 'https://files.test/f/one',
        expiresAt: null,
        shop: { manifest, name: 'Demo Shop' },
        rules: { text: 'Line one.\nLine two.' },
      })
    ).text,
  ).toMatchInlineSnapshot(`
    "Shop rules (https://shop.test/.well-known/annon-shop.json):
    Line one.
    Line two.
    fileId: 0x2222222222222222222222222222222222222222222222222222222222222222
    url: https://files.test/f/one
    expiresAt: no expiry"
  `);
  const expiring = await both(['share', 'a.txt', '--price', '0.1'], {
    fileId: terms.file_id,
    expiresAt: 1795294406,
  });
  expect(expiring.text.split('\n')[1]).toBe(`expiresAt: ${localTime(1795294406000)} (1795294406)`);
});

it('a human error is one readable line with its code, facts and wait; --json keeps the envelope', async () => {
  const fail = async () => {
    throw Object.assign(new AdapterError('settlement_pending', 'Not settled yet.', 4), {
      purchaseId: id,
      retryAfterSeconds: 30,
    });
  };
  const lines: string[] = [];
  expect(
    await runCli(['open', id, '--output', 'x'], fail, (l) => lines.push(l), { human: true }),
  ).toBe(4);
  expect(lines.join('\n')).toMatchInlineSnapshot(`
    "Error: Not settled yet. (settlement_pending)
    purchaseId: 0xabababababababababababababababababababababababababababababababab
    Try again in 30 seconds."
  `);
  lines.length = 0;
  expect(
    await runCli(['open', id, '--output', 'x', '--json'], fail, (l) => lines.push(l), {
      human: true,
    }),
  ).toBe(4);
  expect(JSON.parse(lines.join(''))).toMatchObject({
    ok: false,
    error: { code: 'settlement_pending', exitCode: 4 },
  });
  lines.length = 0;
  expect(await runCli(['shell'], fail, (l) => lines.push(l))).toBe(2);
  expect(JSON.parse(lines.join('')).error.code).toBe('invalid_arguments');
});
