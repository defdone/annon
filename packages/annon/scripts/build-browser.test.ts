import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { browserBuildOptions } from './build-browser.js';

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
