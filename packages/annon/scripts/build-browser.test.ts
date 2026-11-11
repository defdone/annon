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
