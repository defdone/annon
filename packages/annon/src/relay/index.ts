/** Service entrypoint for relayer admission, durable sponsorship and settlement. */

export { clientKey } from '../net/ip.js';
export { NEAR_USDC } from '../settle-near/terms.js';
export { checkProtocolFee, type ProtocolFee } from './fees.js';
export { keeperBalance } from './keeper-balance.js';
export type { KeeperRecord, KeepOptions, KeepResult, RefundSource } from './keeper-runner.js';
export {
  type Admission,
  type Cutover,
  RelayLedger,
  type RelayLimits,
  type RelayOperation,
  type RelayState,
  requestHash,
  type SponsorshipDecision,
} from './ledger.js';
export {
  type CheckOptions,
  deferPaidUnlock,
  keep,
  RelayError,
  type RelayErrorCode,
  type RelayPolicy,
  type RelayRequest,
  type RelayResult,
  reconcileRelayStorage,
  relay,
  relayStatus,
  retryPaidUnlocks,
  type Sender,
} from './relay.js';
export type { HostingReservation } from './reservation.js';
export { baseEligibility, relayLimits, ZERO_FEE } from './sponsorship.js';
