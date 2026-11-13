import { rpcReply } from '../near/rpc.js';
import { RelayError } from './relay.js';

export interface AdmissionOptions {
  admissionFloor?: bigint;
  admissionBalance?: () => Promise<bigint>;
  alert?: (type: string) => void;
}
const paused = new WeakMap<NonNullable<AdmissionOptions['alert']>, boolean>();
/** Final liquid account funds, excluding required account storage stake. */
export async function admissionBalance(nearRpc: string, accountId: string): Promise<bigint> {
  const account = await rpcReply(nearRpc, 'query', {
    request_type: 'view_account',
    finality: 'final',
    account_id: accountId,
  });
  const a = account.result as {
    amount?: unknown;
    locked?: unknown;
    storage_usage?: unknown;
    block_hash?: string;
  };
  const integer = (v: unknown): bigint => {
    if (
      !(
        (typeof v === 'string' && /^\d+$/.test(v)) ||
        (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
      )
    )
      throw new RelayError('relayer_unavailable');
    return BigInt(v);
  };
  if (account.error || !a?.block_hash) throw new RelayError('relayer_unavailable');
  const usage = integer(a.storage_usage),
    amount = integer(a.amount),
    locked = integer(a.locked);
  const protocol = await rpcReply(nearRpc, 'EXPERIMENTAL_protocol_config', {
    block_id: a.block_hash,
  });
  const price = (protocol.result as { runtime_config?: { storage_amount_per_byte?: unknown } })
    ?.runtime_config?.storage_amount_per_byte;
  if (protocol.error) throw new RelayError('relayer_unavailable');
  const stake = usage <= 770n ? 0n : usage * integer(price);
  const held = stake > locked ? stake - locked : 0n;
  return amount > held ? amount - held : 0n;
}
export async function checkAdmissionFloor(method: string, o: AdmissionOptions): Promise<void> {
  if (['unlock', 'claim_key', 'reopen'].includes(method) || o.admissionFloor === undefined) return;
  let balance: bigint;
  try {
    if (!o.admissionBalance) throw new Error('balance unavailable');
    balance = await o.admissionBalance();
  } catch {
    const error = new RelayError('relayer_unavailable');
    error.retryAt = Date.now() + 30000;
    throw error;
  }
  const below = balance < o.admissionFloor;
  if (o.alert && paused.get(o.alert) !== below) {
    const previous = paused.get(o.alert);
    paused.set(o.alert, below);
    if (below || previous === true) o.alert(below ? 'admissions_paused' : 'admissions_resumed');
  }
  if (below) {
    const error = new RelayError('budget');
    error.retryAt = Date.now() + 30000;
    throw error;
  }
}
