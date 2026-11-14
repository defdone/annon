/** Seller commands: `share` through a hosted shop, `sell` a local file, `stop` a listing. */
import { basename, join } from 'node:path';
import { identityJson } from '../settle-near/identity.js';
import { fail, isId } from './adapter-checks.js';
import { amount, nearAmount } from './amounts.js';
import type { CommandSession } from './command-context.js';
import { AdapterError, usage } from './errors.js';
import { fileSource, newOutput, withSpool, writeStream } from './io.js';
import type { selectedShopRules } from './shops.js';
import { identity } from './wallets.js';

/**
 * `share`: hosts the file with the selected shop and registers it; in a human session the seller
 * approves the sale terms first. `--resume` continues a saved hosted sale.
 */
async function share(
  ctx: CommandSession,
  hostedOrigin: string | undefined,
  shopRules: Awaited<ReturnType<typeof selectedShopRules>>,
): Promise<Record<string, unknown>> {
  const { c, d, o, sdk, wallet } = ctx;
  if (!o.target || !hostedOrigin || !sdk.share || !sdk.resumeShare) throw usage();
  const seller = await wallet();
  const hosting = {
    origin: hostedOrigin,
    ...(seller.signUpload ? { signUpload: seller.signUpload } : {}),
    spool: <T>(
      stream: ReadableStream<Uint8Array>,
      use: (source: import('../envelope/replay.js').ReplayableSource) => Promise<T>,
    ) => withSpool(join(c.stateDir, 'hosted'), stream, use),
  };
  const data = await fileSource(o.target);
  if (o.resume) {
    if (
      !isId(o.resume) ||
      [o.price, o.title, o.description, o.storageBudget, o.listingStorage].some(
        (v) => v !== undefined,
      )
    )
      throw usage();
    return {
      ...(await sdk.resumeShare({ fileId: o.resume, data, seller, hosting })),
      ...shopRules,
    };
  }
  if (!o.price) throw usage();
  const near = seller.identity.kind === 'near';
  if (
    near &&
    (d.agent || o.json) &&
    (!(d.agent ? c.listingStorage : (o.listingStorage ?? c.listingStorage)) ||
      !(d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget)))
  )
    throw new AdapterError(
      'storage_required',
      'Configure listingStorage and storageBudget, or provide --listing-storage and --storage-budget in a human CLI session, before noninteractive NEAR sharing.',
      2,
    );
  const listingStorage = near
    ? nearAmount(
        d.agent ? (c.listingStorage ?? '0.01') : (o.listingStorage ?? c.listingStorage ?? '0.01'),
      )
    : undefined;
  const storageBudget = near
    ? nearAmount(
        d.agent ? (c.storageBudget ?? '0.05') : (o.storageBudget ?? c.storageBudget ?? '0.05'),
      )
    : undefined;
  if (!near && (o.listingStorage || o.storageBudget)) throw usage();
  return {
    ...shopRules,
    ...(await sdk.share({
      data,
      name: basename(o.target),
      mime: 'application/octet-stream',
      seller,
      price: amount(o.price),
      hosting,
      ...(o.title !== undefined ? { title: o.title } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(listingStorage !== undefined ? { listingStorage } : {}),
      ...(storageBudget !== undefined ? { storageBudget } : {}),
      onSplit: async (split, fee, aboveMaximum) => {
        if (aboveMaximum && (d.agent || o.json))
          throw new AdapterError(
            'protocol_fee_above_max',
            'Review maxProtocolFee in human configuration.',
            2,
          );
        const terms = {
          seller: seller.identity,
          host: hostedOrigin,
          contract: c.contractId,
          price: split.price,
          split,
          fee: fee ?? null,
          listingStorage: listingStorage?.toString() ?? null,
          purchaseStorage: storageBudget?.toString() ?? null,
          registerDeposit: '0',
        };
        d.paymentTerms?.(terms);
        if (
          !d.agent &&
          !o.json &&
          !(await d.prompt?.(`${JSON.stringify(terms)}\nType yes to share: `))
        )
          throw new AdapterError('sale_not_approved', 'Sale terms were not approved.', 3);
      },
      // The configured secret is separate from the durable backup files.
      confirmBackup: async () => {},
    })),
  };
}

/** `sell`: writes the encrypted .pay2 file and registers its split; `--resume` continues one. */
async function sell(ctx: CommandSession): Promise<Record<string, unknown>> {
  const { c, d, o, sdk, wallet } = ctx;
  if (!o.target) throw usage();
  const seller = await wallet();
  const output = o.output ?? `${o.target}.pay2`;
  await newOutput(output);
  const publish = async (file: { file: ReadableStream<Uint8Array> }) => {
    await writeStream(output, file.file);
  };
  if (o.resume) {
    if (!isId(o.resume) || o.price || o.split || o.base || o.moderator || o.storageBudget)
      throw usage();
    const result = await sdk.resumeSell({
      fileId: o.resume,
      data: await fileSource(o.target),
      seller,
      publish,
    });
    return {
      fileId: result.terms.file_id,
      file: output,
      terms: result.terms,
      ...(result.baseSplit ? { baseSplit: result.baseSplit } : {}),
    };
  }
  if (!o.price || !o.split) throw usage();
  if (o.base && !c.baseRpc)
    return fail('base_rpc_required', 'Configure baseRpc before creating a Base listing.', 2);
  const recipients = o.split.split(',').map((entry) => {
    const at = entry.lastIndexOf(':');
    return { identity: identity(entry.slice(0, at)), bps: Number(entry.slice(at + 1)) };
  });
  if (
    !recipients.length ||
    recipients.length > 8 ||
    recipients.some((r) => !Number.isInteger(r.bps) || r.bps <= 0 || r.bps > 10000) ||
    recipients.reduce((n, r) => n + r.bps, 0) !== 10000 ||
    new Set(recipients.map((r) => identityJson(r.identity))).size !== recipients.length
  )
    throw usage();
  const remainder = recipients[0]?.identity;
  if (!remainder) throw usage();
  if (o.base && (!seller.sendBase || recipients.some((r) => r.identity.kind !== 'evm')))
    return fail(
      'base_wallet_required',
      'Base listings require an EVM wallet and EVM split recipients.',
      2,
    );
  const storageBudget = d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget);
  const selfNear = seller.identity.kind === 'near';
  if (o.storageBudget && !selfNear)
    return fail('invalid_arguments', '--storage-budget requires a self-registered NEAR sell.', 2);
  if (selfNear && !storageBudget)
    d.notify?.(
      'This self-registered file has no purchase storage budget. Fund it before NEAR or 1Click purchases.',
    );
  const result = await sdk.sell({
    data: await fileSource(o.target),
    name: basename(o.target),
    mime: 'application/octet-stream',
    seller,
    near: { price: amount(o.price), recipients, remainder },
    ...((!c.relayer || seller.identity.kind === 'near') &&
    (d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget))
      ? {
          storageBudget: nearAmount(
            (d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget)) as string,
          ),
        }
      : {}),
    onSplit: async (split, fee, aboveMaximum) => {
      if (aboveMaximum && (d.agent || o.json))
        return fail(
          'protocol_fee_above_max',
          'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
          2,
        );
      if (!c.relayer || seller.identity.kind === 'near') return;
      const description = [
        'Sponsored sale split:',
        ...(fee
          ? [
              `Protocol fee: ${fee.fixed} USDC base units + ${fee.bps} bps.`,
              ...(aboveMaximum ? ['This exceeds maxProtocolFee.'] : []),
            ]
          : []),
        ...split.recipients.map(
          (r, i) =>
            `${identityJson(r.identity)}: ${(r.bps / 100).toFixed(2)}%${i === split.remainder ? ' (rounding remainder)' : ''}`,
        ),
      ].join('\n');
      if (!d.agent && !o.json) {
        d.notify?.(description);
        if (!(await d.prompt?.(`${description}\nType yes to register: `)))
          return fail('sale_not_approved', 'Sale split was not approved.', 3);
      }
    },
    ...(o.base
      ? {
          base: {
            price: amount(o.price),
            sendTransaction: async (call) => {
              await seller.sendBase?.(call, c.baseRpc);
            },
          },
        }
      : {}),
    ...(o.moderator ? { moderator: o.moderator } : {}),
    publish,
  });
  return {
    fileId: result.terms.file_id,
    file: output,
    terms: result.terms,
    ...(result.baseSplit ? { baseSplit: result.baseSplit } : {}),
    ...(selfNear && !storageBudget
      ? {
          warnings: [
            'This file has no purchase storage budget. Fund it before NEAR or 1Click purchases.',
          ],
        }
      : {}),
  };
}

/** `stop`: the registered seller stops new sales of a file. */
async function stop(ctx: CommandSession): Promise<Record<string, unknown>> {
  const { o, sdk, wallet } = ctx;
  if (!o.target || !isId(o.target)) throw usage();
  await sdk.stop({ fileId: o.target, seller: await wallet() });
  return { fileId: o.target, stopped: true };
}

export { sell, share, stop };
