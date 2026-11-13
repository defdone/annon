/** Check the installed package boundary using local tarballs, without a registry. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'annon-package-'));
const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: 'pipe' }).toString();
const typeImports = [];
let entries = 0,
  refused = 0;
try {
  await writeFile(join(temp, 'package.json'), '{"type":"module"}');
  for (const source of [sdk, resolve(sdk, '../annon-mcp')]) {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    run('pnpm', ['pack', '--pack-destination', temp], source);
    const archive = join(
      temp,
      (await readdir(temp)).find((file) => file.endsWith('.tgz')),
    );
    const packed = run('tar', ['-tzf', archive], temp).trim().split('\n');
    assert(
      !packed.some((file) =>
        /(?:\.map$|(?:^|\/)[^/]*\.test\.|siwx|\/test\/|\/fixtures\/)/i.test(file),
      ),
    );
    const installed = join(temp, 'node_modules', manifest.name);
    await mkdir(installed, { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', installed], temp);
    await rm(archive);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency === '@defdone/annon') continue;
      const target = join(installed, 'node_modules', dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(source, 'node_modules', dependency), target);
    }
    for (const file of packed.filter((file) => /\.(?:js|ts)$/.test(file))) {
      const content = await readFile(join(installed, file.replace(/^package\//, '')), 'utf8');
      assert(!content.includes('sourceMappingURL='));
    }
    const allowed =
      manifest.name === '@defdone/annon-mcp'
        ? ['.']
        : [
            '.',
            './browser',
            './browser/purchase-bundle.js',
            './node',
            './relay',
            './download/host',
            './download/http',
            './envelope/pay2',
            './near/rpc',
            './pay/seller',
            './pay/settle',
            './pay/split',
            './pay/store',
            './pay/store-node',
            './node/signer-mock',
            './node/adapter',
            './node/cli',
            './node/errors',
          ];
    assert.deepEqual(Object.keys(manifest.exports).sort(), allowed.sort());
    const imports = allowed.map((key) => manifest.name + key.slice(1));
    for (const [key, value] of Object.entries(manifest.exports))
      if (value.types)
        typeImports.push(
          `type Entry${typeImports.length} = typeof import('${manifest.name}${key.slice(1)}');`,
        );
    const forbidden = new Set([
      'package.json',
      'dist/index.js',
      'siwx',
      'relay/relay',
      ...packed
        .filter((file) => /\.(?:js|ts)$/.test(file))
        .map((file) => file.replace(/^package\/dist\//, '').replace(/\.(?:d\.ts|js)$/, '')),
    ]);
    const probe = join(temp, 'probe.mjs');
    await writeFile(
      probe,
      `import assert from 'node:assert/strict';
      for (const path of ${JSON.stringify(imports)}) await import(path);
      for (const path of ${JSON.stringify([...forbidden].map((p) => `${manifest.name}/${p}`).filter((p) => !imports.includes(p)))}) {
        await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      }
      const root = await import('@defdone/annon');
      for (const name of ['openTo', 'applyProtocolFee', 'applySponsoredFee', 'requiredFeeBps', 'encodeTerms','resetRelayState','verifyPreview']) assert(!(name in root));
      const browser = await import('@defdone/annon/browser');
      for (const name of ['catalog','listShops','canonicalManifestUrl','importSellerKey','exportSellerKey','AnnonError','PayError','Pay2Error','DownloadError','CkdError','NearError','BaseRpcRateLimited','NearRpcRateLimited','TransactionUncertain','FileFundingRefused','OneClickQuoteExpired','OneClickRefused','SellError','SourceChangedError','BrowserWalletError','PurchaseLeaseBusy']) {
        assert.equal(typeof root[name], 'function'); assert.equal(root[name], browser[name]);
      }
      for (const [path,names] of [['envelope/pay2',['MAX_PREVIEW','hexBytes','sellerAddress','checkRegistration','previewLengthForLines','verifyPreview']],['pay/seller',['offerFor','ANNON_SCHEMA']],['pay/split',['SPLITS_WAREHOUSE']],['node/cli',['HELP']]]) {
        const entry = await import('@defdone/annon/'+path); for (const name of names) assert(!(name in entry));
      }
      const relay = await import('@defdone/annon/relay');
      assert.deepEqual(Object.keys(relay).sort(), [
        'clientKey', 'NEAR_USDC',
        'RelayError', 'RelayLedger', 'ZERO_FEE', 'baseEligibility', 'checkProtocolFee',
        'deferPaidUnlock', 'keep', 'keeperBalance', 'reconcileRelayStorage', 'relay',
        'relayLimits', 'relayStatus', 'requestHash', 'retryPaidUnlocks',
      ].sort());`,
    );
    // MCP resolves the SDK only after both packages have been installed.
    run(process.execPath, [probe], temp);
    entries += imports.length;
    refused += [...forbidden].filter((p) => !imports.includes(`${manifest.name}/${p}`)).length;
  }
  await writeFile(
    join(temp, 'consumer.ts'),
    `
    ${typeImports.join('\n')}
    import { catalog, listShops, canonicalManifestUrl, importSellerKey, exportSellerKey, type SellerKeyRecord, type DiscoveryConfig, type ShopManifest, type CatalogEntry, fileFundingText, type FileFundingArgs, Annon, checkBaseSponsorship, validBaseSponsorship, type BaseSponsorship, MAX_PAY2_BYTES, MAX_PLAINTEXT_BYTES, HTTP_RETRY_MAX_WAIT_SECONDS, BASE_ELIGIBILITY_MAX_AGE_SECONDS, type DownloadErrorCode } from '@defdone/annon';
    import { importSellerKey as browserImportSellerKey, catalog as browserCatalog, checkBaseSponsorship as browserCheck } from '@defdone/annon/browser';
    import { RelayLedger, relay, keep, RelayError, type CheckOptions, type RelayRequest, type RelayErrorCode, type RelayState, type Sender, type KeepOptions } from '@defdone/annon/relay';
    import { createAdapter, type Input, publicError } from '@defdone/annon/node';
    import { createServer } from '@defdone/annon-mcp';
    const codes: DownloadErrorCode[] = ['download_limited', 'download_in_progress', 'not_sponsored', 'relayer_unavailable'];
  `,
  );
  const require = createRequire(import.meta.url);
  run(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      join(temp, 'consumer.ts'),
    ],
    temp,
  );
  console.log(
    `Packed validation: ${entries} imports, ${refused} refused paths, runtime and types passed.`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
