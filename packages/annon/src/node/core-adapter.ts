/** Runs one CLI command against the SDK once config, trust and signer are resolved. */
// The imports keep node/adapter.ts's original order, bare ones included, so modules initialize as before.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import '../api/annon.js';
import '../download/download.js';
import '../download/proof.js';
import '../envelope/pay2.js';
import '../errors.js';
import '../near/rpc.js';
import { sleep } from '../net/retry.js';
import '../oneclick/oneclick.js';
import type { EncryptedRecord } from '../pay/backup.js';
import '../pay/backup.js';
import '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import '../pay/x402.js';
import '../relay/capabilities.js';
import '../relay/fees.js';
import '../settle-near/codec.js';
import '../settle-near/identity.js';
import '../wallet/uncertain.js';
import '../wallet/wallet.js';
import './agent.js';
import './browser-login.js';
import './budget.js';
import type { Input } from './cli.js';
import { loadConfig, trustContract } from './config.js';
import './errors.js';
import './io.js';
import './keychain.js';
import './paths.js';
import './payment-terms.js';
import './purchase-guard.js';
import './resources.js';
import './retry-gate.js';
import { shareHost } from './sharing.js';
import { selectedShopRules } from './shops.js';
import './signer-wallet.js';
import './signing.js';
import { type Environment, readBackupSecret } from './wallets.js';

// Modules split out of the adapter load after its original imports, so initialization order is unchanged.

import './adapter-checks.js';
import './amounts.js';
import './offers.js';
import './origin.js';

// The command modules declare functions only; every module they import has loaded by now.

import { buy, prepareBuy, verifyFile } from './buy-commands.js';
import {
  type CommandSession,
  type Dependencies,
  type Resource,
  requestContext,
} from './command-context.js';
import { open, recover, status, statusOnChain } from './purchase-commands.js';
import { createSdk } from './relay-transport.js';
import { sell, share, stop } from './seller-commands.js';
import { fileBudget, fund, fundWithNearWallet } from './storage-commands.js';

export type { Dependencies } from './command-context.js';

/**
 * Steps run in this order for every command: config and contract trust, the checks that need no
 * backup secret, the secret, the local stores and the SDK, then the command itself.
 */
function createCoreAdapter(env: Environment = process.env, d: Dependencies = {}) {
  const fetcher = d.fetch ?? globalThis.fetch;
  const wait = d.wait ?? sleep;
  return async (o: Input): Promise<Record<string, unknown>> => {
    const c = await loadConfig(o, env, false, d.agent);
    await trustContract(
      c,
      o.trustContract === true || c.trustContract === true,
      o.json || d.agent ? undefined : d.prompt,
    );
    const ctx = requestContext(env, d, fetcher, wait, o, c);
    if (o.command === 'budget') return fileBudget(ctx);
    if (o.command === 'verify') return verifyFile(ctx);
    if (o.command === 'status') {
      const settled = await statusOnChain(ctx);
      if (settled) return settled;
    }
    const preparedBuy = o.command === 'buy' ? await prepareBuy(ctx) : undefined;
    const hostedOrigin = o.command === 'share' ? await shareHost(c, o.shop, fetcher) : undefined;
    const shopRules = o.command === 'share' ? await selectedShopRules(c, o.shop, fetcher) : {};
    if (o.command === 'fund') {
      const funded = await fundWithNearWallet(ctx);
      if (funded) return funded;
    }
    let secret: Uint8Array;
    try {
      secret = await readBackupSecret(o, env);
    } catch (error) {
      if (o.command === 'status' && o.target) return ctx.pendingSetup(o.target);
      throw error;
    }
    const storeDir = join(c.stateDir, 'records');
    const resourceDir = join(c.stateDir, 'resources');
    if (o.command !== 'status')
      for (const dir of [storeDir, resourceDir, join(c.stateDir, 'backups')])
        await mkdir(dir, { recursive: true, mode: 0o700 });
    const rawStore = fileStore<EncryptedRecord>(storeDir);
    const resources = fileStore<Resource>(resourceDir);
    const sdk = createSdk(ctx, rawStore, secret);
    // The same object as ctx, so the wallet selected so far stays visible to every step.
    const session: CommandSession = Object.assign(ctx, {
      secret,
      storeDir,
      rawStore,
      resources,
      sdk,
    });
    if (o.command === 'fund') return fund(session);
    if (o.command === 'status') return status(session);
    if (o.command === 'share') return share(session, hostedOrigin, shopRules);
    if (o.command === 'sell') return sell(session);
    if (o.command === 'buy') return buy(session, preparedBuy);
    if (o.command === 'recover') return recover(session);
    if (o.command === 'stop') return stop(session);
    return open(session);
  };
}

export { createCoreAdapter };
