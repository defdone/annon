import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { adaptSource, browserBuildOptions, sourceAdapters } from './build-browser.js';

const require = createRequire(import.meta.url);
const pkg = (name: string, from = require) => dirname(from.resolve(`${name}/package.json`));
const meteorModule = join(pkg('@near-wallet-selector/meteor-wallet'), 'index.js');
const hotModule = join(pkg('@near-wallet-selector/hot-wallet'), 'index.js');
const fromCore = createRequire(join(pkg('@near-wallet-selector/core'), 'index.js'));
const fromHotSdk = createRequire(createRequire(hotModule).resolve('@hot-wallet/sdk'));
/** The reviewed upstream file for each adapter. */
const pinned: [string, string][] = [
  ['js-sha256', join(pkg('js-sha256', fromCore), 'src/sha256.js')],
  ['js-sha256', join(pkg('js-sha256', fromHotSdk), 'src/sha256.js')],
  ['Wallet Selector', join(pkg('@near-wallet-selector/core'), 'index.js')],
  ['Wallet Selector', hotModule],
  ['Meteor Wallet selector module', meteorModule],
  [
    'Meteor Wallet SDK',
    join(pkg('@meteorwallet/sdk', createRequire(meteorModule)), 'dist/index.js'),
  ],
];

it.each([
  'eval("alert(1)")',
  'new Function("return 1")',
  'Function("return 1")',
  'setTimeout("alert(1)", 1)',
  'setInterval(`alert(1)`, 1)',
  'globalThis.Function("return 1")',
  '(0, eval)("alert(1)")',
  'const f = eval; f("alert(1)")',
  'Reflect.construct(Function, ["return 1"])',
  '(0, Function)("return 1")',
])('fails the build on emitted dynamic code: %s', async (contents) => {
  await expect(
    build({ ...browserBuildOptions, entryPoints: [], stdin: { contents }, write: false }),
  ).rejects.toThrow(/CSP/);
});
it('allows function timers and strings that only mention dynamic code', async () => {
  await expect(
    build({
      ...browserBuildOptions,
      entryPoints: [],
      stdin: { contents: 'console.log("eval("); setTimeout(() => console.log(1), 1)' },
      write: false,
    }),
  ).resolves.toBeDefined();
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript fixtures must retain interpolation for the emitted-code scanner.
it.each(['setTimeout(`run(${value})`, 1)', 'setInterval(`run(${value})`, 1)'])(
  'rejects interpolated string timers in the emitted bundle: %s',
  async (contents) => {
    await expect(
      build({ ...browserBuildOptions, entryPoints: [], stdin: { contents }, write: false }),
    ).rejects.toThrow(/CSP/);
  },
);

it('bundles the purchase SDK as browser ESM with the existing CSP scan and no Node imports', async () => {
  const result = await build({
    ...browserBuildOptions,
    entryPoints: ['src/browser/index.ts'],
    format: 'esm',
    write: false,
    metafile: true,
  });
  expect(result.outputFiles[0]?.text).toContain('BrowserPurchaseController');
  expect(Object.keys(result.metafile.inputs).some((path) => /(^|\/)src\/node\//.test(path))).toBe(
    false,
  );
  expect(result.outputFiles[0]?.text).not.toMatch(/(?:from|import\s*\()\s*["']node:/);
});

it('every source adapter matches a reviewed upstream file and covers each digest it lists', () => {
  const seen = new Set<string>();
  for (const [name, file] of pinned) {
    const source = readFileSync(file, 'utf8');
    expect(adaptSource(name, source)).not.toBe(source);
    seen.add(`${name}:${createHash('sha256').update(source).digest('hex')}`);
  }
  for (const a of sourceAdapters)
    for (const d of a.digests) expect(seen).toContain(`${a.name}:${d}`);
});

it.each(pinned)(
  '%s refuses any change to the upstream file, inside removed code too',
  (name, file) => {
    const source = readFileSync(file, 'utf8');
    // In the Meteor SDK, inside the validation region the adapter deletes; elsewhere, appended.
    const marker = '//#region src/ported_common/dapp/dapp.validation.ts\n';
    const at = source.indexOf(marker) + marker.length;
    const inside =
      at >= marker.length
        ? `${source.slice(0, at)}globalThis.__added = 1;\n${source.slice(at)}`
        : `${source}\nglobalThis.__added = 1;\n`;
    expect(() => adaptSource(name, inside)).toThrow(/Review the updated/);
    expect(() => adaptSource(name, `${source} `)).toThrow(/Review the updated/);
  },
);

it('the Meteor adapters drop the zod schemas and the key-pair log, and clear the key on sign-out', () => {
  const sdk = adaptSource('Meteor Wallet SDK', readFileSync(pinned[5]?.[1] ?? '', 'utf8'));
  expect(sdk).not.toMatch(/console\.log\(accessKey\)|from "zod"|\bz\.object|ZO_/);
  const module = adaptSource('Meteor Wallet selector module', readFileSync(meteorModule, 'utf8'));
  expect(module).toContain(
    'if (accountId) yield _state.keyStore.removeKey(options.network.networkId, accountId);',
  );
  expect(module).not.toContain("Function('return this')()");
});
