import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildOptions, build, type Plugin } from 'esbuild';
import ts from 'typescript';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Replace `from` with `to`, which must occur exactly `count` times. */
function exact(source: string, from: string, to: string, count = 1) {
  if (source.split(from).length !== count + 1) throw new Error('adapter target not found');
  return source.replaceAll(from, to);
}

/**
 * Source changes made to pinned browser-only dependency copies. Each adapter accepts only the exact
 * upstream file it was reviewed against (SHA-256 of the whole file), so any upstream change, even a
 * line added inside a removed region, fails the build until the adapter is reviewed again.
 */
export const sourceAdapters: readonly {
  name: string;
  filter: RegExp;
  digests: readonly string[];
  transform(source: string): string;
}[] = [
  {
    // Browsers use the pure JS hashing implementation, never Node crypto. 0.9 reaches it through
    // eval, 0.11 (HOT Wallet SDK) through require.
    name: 'js-sha256',
    filter: /[/\\]js-sha256[/\\]src[/\\]sha256\.js$/,
    digests: [
      '6db368b33e4994675ecdc1fcbf175b27e6ff8552904d3471adbfa4335de9c5cd', // 0.9.0
      '2db6c8e554fbee14672368a0d7551a8ddd841ee96c91526eb7987a0179cfc717', // 0.11.1
    ],
    transform(source) {
      const start = source.indexOf('  var nodeWrap = function (method, is224) {');
      const end = source.indexOf('  var createHmacOutputMethod', start);
      if (start < 0 || end < 0) throw new Error('adapter target not found');
      return `${source.slice(0, start)}  var nodeWrap = function (method) { return method; };\n\n${source.slice(end)}`;
    },
  },
  {
    // ES2022 provides globalThis; the legacy global-object fallback needs no code generation.
    name: 'Wallet Selector',
    filter: /[/\\]@near-wallet-selector[/\\](core|hot-wallet)[/\\]index\.js$/,
    digests: [
      '0ac9166489f330e9e95d2f5863fd5bb3d13fc905afa49ceffaeed3f73d0ed6fb', // core 10.1.4
      'd8c1bd0c2b3587c7e34125dfd79c81c779e2f9269cd5985abcd61cbdf2a8d057', // hot-wallet 10.1.4
    ],
    transform: (source) => exact(source, "Function('return this')()", 'globalThis'),
  },
  {
    // Also: sign-out removes the connector key the Meteor SDK generated and stored for the account.
    name: 'Meteor Wallet selector module',
    filter: /[/\\]@near-wallet-selector[/\\]meteor-wallet[/\\]index\.js$/,
    digests: ['112cfa43b95b0e84c72b6e79fa3bd7970989ccd3e69936a80d0b7eb4104b93da'], // 10.1.4
    transform: (source) =>
      exact(
        exact(source, "Function('return this')()", 'globalThis'),
        `        if (_state.wallet.isSignedIn()) {
          yield _state.wallet.signOut();
        }
      });`,
        `        const accountId = _state.wallet.getAccountId();
        if (_state.wallet.isSignedIn()) {
          yield _state.wallet.signOut();
        }
        if (accountId) yield _state.keyStore.removeKey(options.network.networkId, accountId);
      });`,
      ),
  },
  {
    // The SDK imports `utils` from near-api-js 6, which near-api-js 7 no longer exports; its only
    // use decodes a base58 block hash (see the meteor-near-api-js module below). Its unused,
    // unexported zod schemas pull in zod, whose JIT probes `new Function`: removed. Sign-in logged
    // the generated key pair, secret included, to the console: removed.
    name: 'Meteor Wallet SDK',
    filter: /[/\\]@meteorwallet[/\\]sdk[/\\]dist[/\\]index\.js$/,
    digests: ['3489c69e527ebc51981ed416b07dff5a563099df9bd66ac22640841e81fe66bb'], // 1.0.24
    transform(source) {
      const start = source.indexOf('//#region src/ported_common/dapp/dapp.validation.ts\n');
      const end = source.indexOf('//#endregion', start);
      if (start < 0 || end < 0) throw new Error('adapter target not found');
      const kept = source.slice(0, start) + source.slice(end);
      return exact(
        exact(kept, 'import { z } from "zod";\n', ''),
        '\t\tconsole.log(accessKey);\n',
        '',
      );
    },
  },
];

/** Apply the adapter for `name`, refusing any source other than the reviewed one. */
export function adaptSource(name: string, source: string): string {
  const adapter = sourceAdapters.find((a) => a.name === name);
  if (!adapter?.digests.includes(sha256(source)))
    throw new Error(`Review the updated ${name} browser adapter`);
  return adapter.transform(source);
}

/** Remove legacy dynamic-code fallbacks and secret logging from the pinned browser-only
 * dependency copies; never weaken the page CSP. Fail closed if an upstream update changes them.
 */
const cspDependencies: Plugin = {
  name: 'csp-browser-dependencies',
  setup(builder) {
    for (const adapter of sourceAdapters)
      builder.onLoad({ filter: adapter.filter }, async ({ path }) => ({
        contents: adaptSource(adapter.name, await readFile(path, 'utf8')),
        loader: 'js',
      }));
    builder.onResolve({ filter: /^near-api-js$/ }, ({ importer }) =>
      /[/\\]@meteorwallet[/\\]sdk[/\\]/.test(importer)
        ? { path: 'near-api-js-utils', namespace: 'meteor-near-api-js' }
        : undefined,
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
