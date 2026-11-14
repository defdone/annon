/** Relay request, policy, sender and result types with shared errors. */

import { AnnonError } from '../errors.js';
import type { FileInfo } from '../near/rpc.js';
import type { FileFundingArgs, RegisterArgs, ReopenArgs, SellerArgs } from '../near/texts.js';
import type { EvmLog } from '../pay/base.js';
import type { Authorization } from '../settle-near/identity.js';
import type { AdmissionOptions } from './admission.js';
import type { ProtocolFee } from './fees.js';
import type { RelayLedger, RelayLimits } from './ledger.js';
import type { HostingReservation } from './reservation.js';

export type RelayRequest =
  | { method: 'fund_file_storage'; args: FileFundingArgs; auth: Authorization }
  | {
      method: 'register';
      args: RegisterArgs;
      auth: Authorization;
      baseSplit?: { kind: 'push' | 'pull'; salt: string };
      hostingReservation?: HostingReservation;
    }
  | { method: 'reopen'; args: ReopenArgs; auth: Authorization }
  | { method: 'stop_sales' | 'reopen_seller'; args: SellerArgs; auth: Authorization }
  | { method: 'claim_key'; args: { purchase_id: string; grant?: number } }
  | { method: 'unlock'; args: { purchase: string; logs: EvmLog[]; header: string | null } };

export type RelayErrorCode =
  | 'budget'
  | 'bad_request'
  | 'bad_signature'
  | 'bad_deadline'
  | 'not_sponsored'
  | 'limited'
  | 'duplicate'
  | 'in_flight'
  | 'unavailable'
  | 'unknown_file'
  | 'already_registered'
  | 'sales_stopped'
  | 'taken_down'
  | 'not_buyer'
  | 'payment_not_found'
  | 'settlement_pending'
  | 'relayer_unavailable'
  | 'payment_used'
  | 'bad_header'
  | 'transport';

export interface RelayPolicy {
  minPrice: bigint;
  baseSponsorship?: boolean;
  openPoolEnabled?: boolean;
  listedRegistrationsPerSeller?: number;
  unlocksPerFile?: number;
  unlocksPerSeller?: number;
  listedUnlocksPerFile?: number;
  listedUnlocksPerSeller?: number;
  listedTopupPerFile?: bigint;
  listedTopupPerFileDay?: bigint;
  topupListedReserved?: bigint;
  prepaidUnlockFloor?: bigint;
  storagePerWrite?: bigint;
  topupMaxDeadlineSeconds?: number;
  /** Listed sellers get a larger allocation; unlisted sellers remain eligible. */
  fileBudget?: bigint;
  listedFileBudget?: bigint;
  fee?: ProtocolFee;
  sponsoredFilesPerDay?: number;
  topupPerFile?: bigint;
  topupPerFileDay?: bigint;
  topupPerDay?: bigint;
  maxDeadlineSeconds: number;
  /** Listed-seller predicate for allocation tiers; does not deny unlisted sellers. */
  sellerAllowed?: (seller: string) => boolean | Promise<boolean>;
  registrationsPerSeller?: number;
  reopensPerWalletFile?: number;
  /** Daily limit per (purchase, grant). */
  claimsPerGrant?: number;
  holdMs?: number;
  maxWaiting?: number;
  maxChecking?: number;
}

export interface CheckOptions extends AdmissionOptions {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  usdc: string;
  nearUsdc?: string;
  policy: RelayPolicy;
  now?: number;
  network?: string;
  ledger?: RelayLedger;
  admissionLimits?: Partial<RelayLimits>;
  ip?: string;
  acceptingNewBasePayments?: boolean;
  historicalFile?: (fileId: string, blockHash: string) => Promise<FileInfo | null>;
  reservation?: {
    hostOrigin: string;
    publicKey: string;
    fetch?: typeof fetch;
    maxFileBytes?: number;
  };
  alert?: (type: string) => void;
}

// ---------- sending ----------

export interface Sender {
  /** The NEAR account that sends and pays, e.g. `relayer.annon.defdone.near`. */
  accountId: string;
  /** Its function-call key for the relay methods, including file funding, `ed25519:…`. Only for this contract. */
  key: string;
}

export interface RelayResult {
  txHash: string;
  /**
   * NEAR's answer was lost or unclear (a timeout, a gateway error, a refusal): the transaction may
   * or may not be in a block. Read its outcome by hash before asking again. Sending the same
   * operation again is safe: the contract refuses it if the first one landed.
   */
  uncertain?: true;
  /** RPC validation refused this submission before execution. */
  rejected?: true;
  /** With `uncertain` or `rejected`: what NEAR answered, for the operator. */
  reason?: string;
}

export class RelayError extends AnnonError {
  // A plain field, not a parameter property: the relayer runs this file with Node's type
  // stripping, which has no parameter properties.
  readonly code: RelayErrorCode;
  retryAt?: number;
  constructor(code: RelayErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'RelayError';
  }
}

const fail = (code: RelayErrorCode, message?: string): never => {
  throw new RelayError(code, message);
};

export { fail };
