import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { OneClick } from '../oneclick/oneclick.js';
import { head } from '../pay/base.js';
import { rpcReply } from './rpc.js';

afterEach(() => vi.unstubAllGlobals());

it('omits credentials at the NEAR RPC boundary', async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const { id } = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id, result: null });
  });
  vi.stubGlobal('fetch', transport);
  await rpcReply('https://rpc.example', 'status', []);
  expect(transport.mock.calls[0]?.[1]?.credentials).toBe('omit');
});

it('omits credentials on every Base RPC request', async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const { id, method } = JSON.parse(String(init?.body));
    return Response.json({
      jsonrpc: '2.0',
      id,
      result: method === 'eth_chainId' ? '0x2105' : { number: '0x1', timestamp: '0x2' },
    });
  });
  vi.stubGlobal('fetch', transport);
  await head('https://rpc.example');
  expect(transport.mock.calls.length).toBeGreaterThan(1);
  for (const [, init] of transport.mock.calls) expect(init?.credentials).toBe('omit');
});

it('omits credentials at the 1Click transport boundary', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json([]));
  await new OneClick({ fetch: transport }).tokens();
  expect(transport.mock.calls[0]?.[1]?.credentials).toBe('omit');
});

it('requires credential omission for SDK fetch calls and lists separate owner follow-ups', () => {
  // Named third-party exception: relay/relay.ts signingProvider uses near-api-js 7.4.
  // Its JsonRpcProvider has no custom fetch option. This relayer-only Node transport
  // has no ambient cookie jar; nonce/block reads retain the provider's error parsing.
  // Transaction sends and lookups already use rpcReply.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const missing: string[] = [];
  const followUps: string[] = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const path = String(entry);
    if (!path.endsWith('.ts') || /\.(test|spec)\.ts$/.test(path)) continue;
    for (const line of credentialFailures(readFileSync(root + path, 'utf8'))) {
      const finding = `${path}:${line}`;
      (/^(api|browser|node|shops)\//.test(path) ? followUps : missing).push(finding);
    }
  }
  expect(missing, missing.join('\n')).toEqual([]);
  if (followUps.length)
    console.warn(`Separate owner credential follow-ups:\n${followUps.join('\n')}`);
});

function credentialFailures(text: string): number[] {
  const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
  const failures: number[] = [];
  const declared = new Map<string, ts.Expression | null>();
  const collect = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const init =
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const
          ? node.initializer
          : null;
      declared.set(node.name.text, declared.has(node.name.text) ? null : init);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  type State = 'omit' | 'other' | 'unset' | 'unknown';
  const credentialsOf = (node: ts.Node | undefined, depth = 0): State => {
    if (!node || depth > 8) return 'unknown';
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return credentialsOf(node.expression, depth + 1);
    if (ts.isIdentifier(node))
      return credentialsOf(declared.get(node.text) ?? undefined, depth + 1);
    if (ts.isConditionalExpression(node)) {
      const a = credentialsOf(node.whenTrue, depth + 1);
      return a === credentialsOf(node.whenFalse, depth + 1) ? a : 'unknown';
    }
    if (!ts.isObjectLiteralExpression(node)) return 'unknown';
    let state: State = 'unset';
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) {
        const s = credentialsOf(p.expression, depth + 1);
        if (s !== 'unset') state = s;
      } else if (p.name?.getText(source) === 'credentials') {
        state =
          ts.isPropertyAssignment(p) &&
          ts.isStringLiteral(p.initializer) &&
          p.initializer.text === 'omit'
            ? 'omit'
            : 'other';
      }
    }
    return state;
  };
  // Conservative source scan, not data-flow analysis: reassignment, destructured aliases,
  // dynamic property names and calls through bind/apply require manual review.
  const isFetch = (node: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return isFetch(node.expression, depth + 1);
    if (ts.isIdentifier(node)) {
      const init = declared.get(node.text);
      return /^(fetch|fetcher)$/.test(node.text) || !!(init && isFetch(init, depth + 1));
    }
    if (ts.isPropertyAccessExpression(node)) return /^(fetch|fetcher)$/.test(node.name.text);
    if (ts.isElementAccessExpression(node))
      return (
        ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'fetch'
      );
    if (ts.isBinaryExpression(node))
      return isFetch(node.left, depth + 1) || isFetch(node.right, depth + 1);
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const call =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'call' &&
        isFetch(node.expression.expression);
      if (
        (call || isFetch(node.expression)) &&
        credentialsOf(node.arguments[call ? 2 : 1]) !== 'omit'
      )
        failures.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

it.each([
  "fetch(url, { credentials: 'omit', ...{ credentials: 'include' } });",
  "fetch(url, { credentials: 'omit', ...init });",
  "const opts = { credentials: 'omit' }; function f(opts) { fetch(url, opts); }",
  'const go = o.fetch ?? fetch; go(url, {});',
  "globalThis['fetch'](url, {});",
  'fetch.call(globalThis, url, {});',
])('flags unsafe credential probe: %s', (probe) => {
  expect(credentialFailures(probe)).toHaveLength(1);
});

it.each([
  "fetch(url, { ...{ credentials: 'include' }, credentials: 'omit' });",
  "fetch(url, { credentials: 'omit', ...{} });",
  "const opts = ({ credentials: 'omit' } as RequestInit) satisfies RequestInit; fetch(url, (opts));",
  "fetch(url, ok ? { credentials: 'omit' } : { credentials: 'omit' });",
])('accepts proven omission: %s', (probe) => {
  expect(credentialFailures(probe)).toEqual([]);
});
it.each([
  "let opts = { credentials: 'omit' }; fetch(url, opts);",
  "const opts = { credentials: 'omit' }; function f() { const opts = {}; } fetch(url, opts);",
  "const opts = {}; function f() { const opts = { credentials: 'omit' }; } fetch(url, opts);",
  "fetch(url, ok ? { credentials: 'omit' } : {});",
])('rejects uncertain omission: %s', (probe) => {
  expect(credentialFailures(probe)).toHaveLength(1);
});
