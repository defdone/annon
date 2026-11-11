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
      if (start < 0 || end < 0 || (source.slice(start, end).match(/\beval\(/g) ?? []).length !== 2)
        throw new Error('Review the updated js-sha256 browser CSP adapter');
      // Browsers use the existing pure JS hashing implementation, never Node crypto via eval.
      return {
        contents: `${source.slice(0, start)}  var nodeWrap = function (method) { return method; };\n\n${source.slice(end)}`,
        loader: 'js',
      };
    });
    builder.onLoad(
      { filter: /[/\\]@near-wallet-selector[/\\](core|my-near-wallet)[/\\]index\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const fallback = "Function('return this')()";
        if (source.split(fallback).length !== 2)
          throw new Error('Review the updated Wallet Selector browser CSP adapter');
        // ES2022 provides globalThis; the legacy global-object fallback needs no code generation.
        return { contents: source.replace(fallback, 'globalThis'), loader: 'js' };
      },
    );
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
  plugins: [cspDependencies, emittedCsp],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outfile = 'dist/browser/login-bundle.js';
  // Never leave a stale or rejected bundle behind: write only after the emitted-code scan passed.
  await rm(outfile, { force: true });
  const result = await build({ ...browserBuildOptions, outfile, write: false });
  await mkdir(dirname(outfile), { recursive: true });
  for (const f of result.outputFiles) await writeFile(f.path, f.contents);
}
