/** File purchase storage: `budget` reads what a file has left, `fund` adds to it. */
import { fileStorageBalance } from '../near/rpc.js';
import { fundFileStorage, type NearWallet } from '../wallet/wallet.js';
import { fail, isId } from './adapter-checks.js';
import { nearAmount } from './amounts.js';
import type { CommandSession, RequestContext } from './command-context.js';
import { usage } from './errors.js';
import { loadWallet } from './wallets.js';

/** `budget`: the file's available purchase storage and what one more purchase needs. */
async function fileBudget(ctx: RequestContext): Promise<Record<string, unknown>> {
  const { c, o } = ctx;
  if (!o.target || !isId(o.target)) throw usage();
  const budget = await fileStorageBalance(c.nearRpc, c.contractId, o.target);
  return {
    fileId: o.target,
    available: budget.available.toString(),
    admissionRequirement: budget.admissionRequirement.toString(),
  };
}

/**
 * `fund`, first step: a NEAR owner funds the file directly. Returns nothing for other wallets,
 * which fund through the SDK once it is ready; the loaded wallet stays selected for that step.
 */
async function fundWithNearWallet(
  ctx: RequestContext,
): Promise<Record<string, unknown> | undefined> {
  const { c, d, env, o } = ctx;
  if (d.agent) return fail('human_only', 'File funding requires a human CLI session.', 2);
  if (!o.target || !isId(o.target)) throw usage();
  const text = o.fundAmount;
  if (!text) return fail('invalid_arguments', 'Provide the NEAR amount to allocate.', 2);
  const owner = await (d.wallet ?? loadWallet)({ ...o, network: c.network }, env, c.nearRpc);
  ctx.selected = owner;
  if (owner.identity.kind === 'near') {
    if (!('call' in owner))
      return fail('near_wallet_required', 'File funding requires a NEAR wallet.', 2);
    await fundFileStorage(owner as NearWallet, c.contractId, o.target, nearAmount(text));
    return { fileId: o.target, fundedNear: text };
  }
}

/** `fund` through the SDK, for owners that are not NEAR wallets. */
async function fund(ctx: CommandSession): Promise<Record<string, unknown>> {
  const { o, sdk, wallet } = ctx;
  if (!o.target || !o.fundAmount) throw usage();
  await sdk.fund(o.target, nearAmount(o.fundAmount), await wallet());
  return { fileId: o.target, fundedNear: o.fundAmount };
}

export { fileBudget, fund, fundWithNearWallet };
