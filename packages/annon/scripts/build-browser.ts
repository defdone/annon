import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildOptions, build, type Plugin } from 'esbuild';
import ts from 'typescript';

/** Remove legacy dynamic-code fallbacks from the pinned browser-only dependency copies.
 * Keep the SHA implementation and selector behavior intact; never weaken the page CSP.
 * Fail closed if an upstream update changes the expected source.
 */
const cspDependencies: Plugin = {
  name: 'csp-browser-dependencies',
  setup(builder) {
    builder.onLoad({ filter: /[/\\]js-sha256[/\\]src[/\\]sha256\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const start = source.indexOf('  var nodeWrap = function (method, is224) {');
      const end = source.indexOf('  var createHmacOutputMethod', start);
      const node = start < 0 || end < 0 ? '' : source.slice(start, end);
      // 0.9 reaches Node crypto through eval; 0.11 (HOT Wallet SDK) through require.
      const evals = (node.match(/\beval\(/g) ?? []).length;
      const requires = (node.match(/\brequire\(/g) ?? []).length;
      if (!node || !((evals === 2 && requires === 2) || (evals === 0 && requires === 2)))
        throw new Error('Review the updated js-sha256 browser CSP adapter');
      // Browsers use the existing pure JS hashing implementation, never Node crypto.
      return {
        contents: `${source.slice(0, start)}  var nodeWrap = function (method) { return method; };\n\n${source.slice(end)}`,
        loader: 'js',
      };
    });
    builder.onLoad(
      { filter: /[/\\]@near-wallet-selector[/\\](core|meteor-wallet|hot-wallet)[/\\]index\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const fallback = "Function('return this')()";
        if (source.split(fallback).length !== 2)
          throw new Error('Review the updated Wallet Selector browser CSP adapter');
        // ES2022 provides globalThis; the legacy global-object fallback needs no code generation.
        return { contents: source.replace(fallback, 'globalThis'), loader: 'js' };
      },
    );
    // The Meteor Wallet SDK imports `utils` from near-api-js 6, which near-api-js 7 no longer
    // exports. Its only use decodes a base58 block hash; give it exactly that and nothing else.
    builder.onResolve({ filter: /^near-api-js$/ }, ({ importer }) =>
      /[/\\]@meteorwallet[/\\]sdk[/\\]/.test(importer)
        ? { path: 'near-api-js-utils', namespace: 'meteor-near-api-js' }
        : undefined,
    );
    // Its unused, unexported zod schemas pull in zod, whose JIT probes `new Function`. Drop them.
    builder.onLoad(
      { filter: /[/\\]@meteorwallet[/\\]sdk[/\\]dist[/\\]index\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const zod = 'import { z } from "zod";\n';
        const start = source.indexOf('//#region src/ported_common/dapp/dapp.validation.ts');
        const end = source.indexOf('//#endregion', start);
        const contents =
          start < 0 || end < 0 ? '' : (source.slice(0, start) + source.slice(end)).replace(zod, '');
        if (
          source.split(zod).length !== 2 ||
          source.split('import { utils } from "near-api-js";').length !== 2 ||
          source.split('utils.serialize.base_decode(').length !== 2 ||
          !contents ||
          /\bz\.|ZO_/.test(contents)
        )
          throw new Error('Review the updated Meteor Wallet SDK browser adapter');
        return { contents, loader: 'js' };
      },
    );
    builder.onLoad({ filter: /.*/, namespace: 'meteor-near-api-js' }, () => ({
      contents:
        "import { base58 } from '@scure/base';\nexport const utils = { serialize: { base_decode: (value) => base58.decode(value) } };",
      loader: 'js',
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    }));
  },
};

/** Scan the emitted JavaScript, including dependency code missed by the source adapters. */
const emittedCsp: Plugin = {
  name: 'emitted-browser-csp',
  setup(builder) {
    builder.onEnd(async (result) => {
      if (result.errors.length) return;
      const files = result.outputFiles
        ? result.outputFiles
            .filter((f) => f.path.endsWith('.js') || f.path === '<stdout>')
            .map((f) => f.text)
        : [await readFile(builder.initialOptions.outfile as string, 'utf8')];
      for (const source of files) {
        const file = ts.createSourceFile(
          'bundle.js',
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const inspect = (node: ts.Node) => {
          // Any value use of eval ((0, eval)(x), const f = eval) except as a property name.
          if (
            ts.isIdentifier(node) &&
            node.text === 'eval' &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          )
            throw new Error('Browser CSP forbids emitted dynamic code: eval reference');
          // Function used as a constructor indirectly: Reflect.construct/apply(Function, ...), (0, Function)(x).
          if (
            ts.isIdentifier(node) &&
            node.text === 'Function' &&
            ((ts.isCallExpression(node.parent) &&
              node.parent.arguments[0] === node &&
              ts.isPropertyAccessExpression(node.parent.expression) &&
              ts.isIdentifier(node.parent.expression.expression) &&
              node.parent.expression.expression.text === 'Reflect') ||
              (ts.isBinaryExpression(node.parent) &&
                node.parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
                node.parent.right === node))
          )
            throw new Error('Browser CSP forbids emitted dynamic code: indirect Function');
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee)
              ? callee.text
              : ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : ts.isElementAccessExpression(callee) &&
                    ts.isStringLiteral(callee.argumentExpression)
                  ? callee.argumentExpression.text
                  : '';
            const arg = node.arguments?.[0];
            if (
              ['eval', 'Function'].includes(name) ||
              (['setTimeout', 'setInterval'].includes(name) &&
                arg &&
                (ts.isStringLiteral(arg) ||
                  ts.isNoSubstitutionTemplateLiteral(arg) ||
                  ts.isTemplateExpression(arg)))
            )
              throw new Error(`Browser CSP forbids emitted dynamic code: ${name}`);
          }
          ts.forEachChild(node, inspect);
        };
        inspect(file);
      }
    });
  },
};

export const browserBuildOptions: BuildOptions = {
  entryPoints: ['src/browser/login.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  // Node-era dependencies of the wallet SDKs read `global` (randombytes) and, at module load,
  // `process.env.DEFAULT_FINALITY` (@near-js/accounts 2.2.5). Browsers have neither.
  define: { global: 'globalThis', 'process.env.DEFAULT_FINALITY': 'undefined' },
  plugins: [cspDependencies, emittedCsp],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await emit('dist/browser/login-bundle.js', {});
  await emit('dist/browser/purchase-bundle.js', {
    entryPoints: ['src/browser/index.ts'],
    format: 'esm',
  });
}
async function emit(outfile: string, options: BuildOptions) {
  // Never leave a stale or rejected bundle behind: write only after the emitted-code scan passed.
  await rm(outfile, { force: true });
  const result = await build({ ...browserBuildOptions, ...options, outfile, write: false });
  await mkdir(dirname(outfile), { recursive: true });
  for (const f of result.outputFiles) await writeFile(f.path, f.contents);
}
