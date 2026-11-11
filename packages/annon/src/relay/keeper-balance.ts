import { rpcReply } from '../near/rpc.js';

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('keeper balance/protocol data unavailable');
  return v as Record<string, unknown>;
};
const integer = (v: unknown): bigint => {
  if (
    !(
      (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) ||
      (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
    )
  )
    throw new Error('invalid keeper balance/protocol integer');
  return BigInt(v);
};

/** Price a single zero-deposit function call, before signing, at one finalized block.
 * NEP-642: send fees burn at block price; receipt gas is bought at the protocol minimum.
 * https://near.github.io/nearcore/architecture/how/gas.html
 */
export async function keeperBalance(o: {
  nearRpc: string;
  accountId: string;
  contractId: string;
  block: string;
  gasPrice: bigint;
  method: string;
  args: object;
  gas: bigint;
}): Promise<{ balance: bigint; cost: bigint }> {
  const [account, protocol] = await Promise.all([
    rpcReply(o.nearRpc, 'query', {
      request_type: 'view_account',
      block_id: o.block,
      account_id: o.accountId,
    }),
    rpcReply(o.nearRpc, 'EXPERIMENTAL_protocol_config', { block_id: o.block }),
  ]);
  if (account.error || protocol.error) throw new Error('final keeper balance/protocol unavailable');
  const a = object(account.result);
  const runtime = object(object(protocol.result).runtime_config);
  const fees = object(runtime.transaction_costs);
  const actions = object(fees.action_creation_config);
  const receipt = object(fees.action_receipt_creation_config);
  const call = object(actions.function_call_cost);
  const byte = object(actions.function_call_cost_per_byte);
  const size = BigInt(new TextEncoder().encode(o.method + JSON.stringify(o.args)).length);
  const send = o.accountId === o.contractId ? 'send_sir' : 'send_not_sir';
  const sendGas = integer(receipt[send]) + integer(call[send]) + size * integer(byte[send]);
  const receiptGas =
    o.gas + integer(receipt.execution) + integer(call.execution) + size * integer(byte.execution);
  const minPrice = integer(runtime.min_gas_purchase_price);
  const cost = sendGas * o.gasPrice + receiptGas * (minPrice > o.gasPrice ? minPrice : o.gasPrice);
  const amount = integer(a.amount),
    locked = integer(a.locked),
    usage = integer(a.storage_usage);
  // NEP-448 permits accounts using at most 770 bytes to have zero storage stake.
  const stake = usage <= 770n ? 0n : usage * integer(runtime.storage_amount_per_byte);
  const held = stake > locked ? stake - locked : 0n;
  return { cost, balance: amount > held ? amount - held : 0n };
}
