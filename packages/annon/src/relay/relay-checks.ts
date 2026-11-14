/** Relay authorization, file eligibility and payment evidence checks. */

import { isTransient } from '../errors.js';
import { getFile, getGrant, getPurchase } from '../near/rpc.js';
import { fileFundingText, reopenSellerText, reopenText, stopSalesText } from '../near/texts.js';
import { block, blockHeader, getReceipt, paymentLogs } from '../pay/base.js';
import { createSplit, readSplitState } from '../pay/split.js';
import { identityJson, verifyAuthorization } from '../settle-near/identity.js';
import { baseNonceV2, parsePurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { checkProtocolFee } from './fees.js';
import { asRelayError, refusedBaseTerms, signedByItsWallet, verifiedBaseTerms } from './relay.js';
import { type CheckOptions, fail, type RelayRequest } from './relay-types.js';
import { verifyReservation } from './reservation.js';
import { admitTerms, checkedDecision, temporary } from './sponsorship.js';

export async function checkRelay(r: RelayRequest, o: CheckOptions): Promise<void> {
  try {
    if ('deadline' in r.args) {
      const now = o.now ?? Math.floor(Date.now() / 1000);
      if (
        (r.method === 'fund_file_storage' ? r.args.deadline <= now : r.args.deadline < now) ||
        r.args.deadline >
          now +
            (r.method === 'fund_file_storage'
              ? (o.policy.topupMaxDeadlineSeconds ?? 600)
              : o.policy.maxDeadlineSeconds)
      )
        fail('bad_deadline');
    }
    const fileId =
      r.method === 'register'
        ? r.args.terms.file_id
        : r.method === 'unlock'
          ? parsePurchaseMessage(r.args.purchase, { baseUsdc: o.usdc }).file_id
          : 'file_id' in r.args
            ? r.args.file_id
            : undefined;
    const p =
      r.method === 'reopen' || r.method === 'claim_key'
        ? await getPurchase(o.nearRpc, o.contractId, r.args.purchase_id)
        : null;
    if ((r.method === 'reopen' || r.method === 'claim_key') && !p) fail('not_buyer');
    const target = fileId ?? p?.file_id;
    if (!target) return fail('not_buyer');
    const file = await getFile(o.nearRpc, o.contractId, target);
    if (r.method === 'register') {
      if (
        r.args.terms.contract !== o.contractId ||
        BigInt(r.args.terms.near.price) < o.policy.minPrice ||
        (r.args.terms.base !== null && BigInt(r.args.terms.base.price) < o.policy.minPrice)
      )
        fail('not_sponsored');
      if (file) fail('already_registered');
      signedByItsWallet(r, o.contractId, {
        baseUsdc: o.usdc,
        ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
      });
      if (o.policy.fee) {
        try {
          checkProtocolFee(r.args.terms, o.policy.fee);
        } catch {
          fail('not_sponsored', 'required treasury share missing or invalid');
        }
      }
      if (r.args.terms.base) {
        const provenance = r.baseSplit;
        if (o.policy.baseSponsorship === false || !provenance) return fail('not_sponsored');
        try {
          if (r.args.terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
            throw new Error();
          const split = createSplit(
            provenance.kind,
            {
              recipients: r.args.terms.near.recipients.map((r) => r.identity.id),
              allocations: r.args.terms.near.recipients.map((r) => BigInt(r.bps)),
              totalAllocation: 10000n,
              distributionIncentive: 0,
            },
            provenance.salt,
          );
          if (split.address !== r.args.terms.base.pay_to) throw new Error();
        } catch {
          fail('not_sponsored', 'Base split does not match recipients');
        }
      }
      if (o.ledger) {
        const listed = await o.policy.sellerAllowed?.(identityJson(r.args.terms.seller));
        if (!listed && o.policy.openPoolEnabled === false) temporary();
        await admitTerms(r.args.terms, o, listed ? 'listed' : 'pool');
        if (r.hostingReservation) {
          if (!o.reservation) return fail('not_sponsored');
          await verifyReservation(r.hostingReservation, r.args.terms, {
            ...o.reservation,
            now: o.now ?? Math.floor(Date.now() / 1000),
          }).catch(() => fail('not_sponsored'));
        } else if (!listed) fail('not_sponsored', 'A hosting reservation is required.');
      }
      return;
    }
    if (!file) return fail('unknown_file');
    if (file.takenDown) fail('taken_down');
    if (r.method === 'fund_file_storage') {
      if (
        !verifyAuthorization(
          file.seller,
          fileFundingText({
            ...r.args,
            network: file.terms.network,
            contract: o.contractId,
            seller: file.seller,
          }),
          r.auth,
        )
      )
        fail('bad_signature');
      if (file.salesStoppedAt !== null) fail('sales_stopped');
      if (!o.ledger || !(await o.ledger.decision(r.args.file_id, file.termsHash)))
        fail('not_sponsored');
      return;
    }
    if (r.method === 'claim_key') {
      const price = p?.route === 'base-usdc' ? file.terms.base?.price : file.terms.near.price;
      if (price === undefined || BigInt(price) < o.policy.minPrice) fail('not_sponsored');
      if (!(await getGrant(o.nearRpc, o.contractId, r.args.purchase_id, r.args.grant)))
        fail('not_buyer');
      return;
    }
    if (r.method === 'reopen') {
      if (!p) return fail('not_buyer');
      if (
        !verifyAuthorization(
          p.recovery,
          reopenText({
            ...r.args,
            contract: o.contractId,
            file_id: p.file_id,
            recovery: p.recovery,
          }),
          r.auth,
        )
      )
        fail('bad_signature');
      return;
    }
    if (r.method === 'reopen_seller' || r.method === 'stop_sales') {
      const text =
        r.method === 'stop_sales'
          ? stopSalesText(o.contractId, r.args, file.seller)
          : reopenSellerText(o.contractId, r.args, file.seller);
      if (!verifyAuthorization(file.seller, text, r.auth)) fail('bad_signature');
      if (r.method === 'stop_sales' && file.salesStoppedAt !== null) fail('sales_stopped');
      return;
    }
    if (r.method !== 'unlock') return;
    if (!o.ledger && o.policy.baseSponsorship === false) fail('not_sponsored');
    const a = r.args;
    const purchase = parsePurchaseMessage(a.purchase, { baseUsdc: o.usdc });
    if (!o.ledger && BigInt(purchase.price) < o.policy.minPrice) fail('not_sponsored');
    const id = purchaseId(purchase, { baseUsdc: o.usdc });
    if (
      purchase.route !== 'base-usdc' ||
      purchase.contract !== o.contractId ||
      !file.terms.base ||
      purchase.terms_hash !== file.termsHash ||
      purchase.price !== file.terms.base.price ||
      purchase.asset !== o.usdc
    )
      return fail('bad_request');
    if (o.ledger) await checkedDecision(file, o, true);
    else {
      try {
        if (file.terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
          fail('not_sponsored', 'Base split recipients must be EVM identities');
        if (o.policy.fee) checkProtocolFee(file.terms, o.policy.fee);
      } catch {
        fail('not_sponsored', 'required treasury share missing or invalid');
      }
      const verifiedKey = JSON.stringify([
        o.baseRpc,
        o.nearRpc,
        o.contractId,
        termsHash(file.terms),
      ]);
      const now = Date.now();
      for (const [key, until] of refusedBaseTerms) {
        if (until <= now) refusedBaseTerms.delete(key);
      }
      if (refusedBaseTerms.has(verifiedKey))
        fail('not_sponsored', 'Base split code or state does not match registered recipients');
      if (!verifiedBaseTerms.has(verifiedKey)) {
        try {
          await readSplitState(o.baseRpc, file.terms.base.pay_to, {
            recipients: file.terms.near.recipients.map((r) => r.identity.id),
            allocations: file.terms.near.recipients.map((r) => BigInt(r.bps)),
            totalAllocation: 10000n,
            distributionIncentive: 0,
          });
        } catch (error) {
          if (isTransient(error))
            fail('unavailable', 'Base split verification unavailable; retry later');
          // Bound attacker-controlled refusals; transient RPC failures are never cached.
          if (refusedBaseTerms.size >= 1024) {
            const oldest = refusedBaseTerms.keys().next().value;
            if (oldest !== undefined) refusedBaseTerms.delete(oldest);
          }
          refusedBaseTerms.set(verifiedKey, Date.now() + 60000);
          fail('not_sponsored', 'Base split code or state does not match registered recipients');
        }
        verifiedBaseTerms.add(verifiedKey);
      }
    }
    if (await getPurchase(o.nearRpc, o.contractId, id)) fail('payment_used');
    const auth = a.logs[0];
    if (!auth) return fail('bad_request');
    const found = paymentLogs(await getReceipt(o.baseRpc, `0x${auth.transaction_hash}`), {
      usdc: o.usdc,
      to: file.payTo,
      from: `0x${auth.topics[1]?.slice(-40)}`,
      nonce: baseNonceV2(id),
      price: BigInt(purchase.price),
    });
    if (!found || JSON.stringify(found) !== JSON.stringify(a.logs)) fail('payment_not_found');
    const safe = await block(o.baseRpc, 'safe');
    if (
      safe.number < auth.block_number ||
      (await block(o.baseRpc, auth.block_number)).hash !== `0x${auth.block_hash}`
    )
      fail('settlement_pending');
    if (a.header !== null && (await blockHeader(o.baseRpc, `0x${auth.block_hash}`)) !== a.header)
      fail('bad_header');
    if (file.salesStoppedAt !== null) {
      if (a.header === null) fail('bad_header');
      const paidAt = (await block(o.baseRpc, auth.block_number)).timestamp;
      if (BigInt(paidAt) > BigInt(file.salesStoppedAt) + 300n) fail('sales_stopped');
    }
  } catch (e) {
    asRelayError(e);
  }
}
