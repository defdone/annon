/** Options and results of the Annon client: construction, sell and buy. */
import type { SellData } from '../envelope/replay.js';
import type { Deposit, OneClick, OneClickQuote, Origin } from '../oneclick/oneclick.js';
import type { EncryptedRecord } from '../pay/backup.js';
import type { PurchaseRecord } from '../pay/purchase.js';
import type { SplitCall } from '../pay/split.js';
import type { Store } from '../pay/store.js';
import type { PaymentRequired } from '../pay/x402.js';
import type { BaseSponsorship } from '../relay/capabilities.js';
import type { ProtocolFee } from '../relay/fees.js';
import type { BuyRoute } from '../routes.js';
import type { Identity } from '../settle-near/identity.js';
import type { Terms } from '../settle-near/terms.js';
import type { IdentityWallet, NearWallet } from '../wallet/wallet.js';
import type { ShareHosting, ShareOptions } from './sharing-types.js';

export interface AnnonOptions {
  relayer?: string;
  fetch?: typeof fetch;
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  network: string;
  rawStore: Store<EncryptedRecord>;
  backupSecret: Uint8Array;
  /** Write the encrypted file durably (Node file, download, or an app's backup destination). */
  writeBackup(name: string, encryptedFile: string): Promise<void>;
  /** A transaction transport. Wait for final execution and return its decoded result/outcome. NEAR wallets can call directly when omitted. */
  send?: (method: string, args: object, wallet?: NearWallet) => Promise<unknown>;
  mpcKey?: string;
  now?: () => number;
  /** A relayer capability reader; only sponsored registrations apply its fee. */
  sponsorship?: () => Promise<{ fee: ProtocolFee }>;
  /** Maximum advertised fee, in USDC base units plus basis points. */
  maxProtocolFee?: Pick<ProtocolFee, 'fixed' | 'bps'>;
}
export interface SellOptions<T extends SellData = Uint8Array> {
  /** Hosted jobs use the shared reservation sequence; publish remains a post-registration callback. */
  hosting?: ShareHosting & Pick<ShareOptions, 'listingStorage' | 'confirmBackup'>;
  /** Attached yoctoNEAR for a self-funded listing. */
  storageBudget?: bigint;
  /** Called before registration or Base split transactions. */
  onSplit?: (
    near: Terms['near'],
    fee?: ProtocolFee,
    aboveMaximum?: boolean,
  ) => void | Promise<void>;
  data: T;
  name: string;
  mime: string;
  seller: IdentityWallet;
  near: { price: string; recipients: { identity: Identity; bps: number }[]; remainder: Identity };
  base?: {
    price: string;
    kind?: 'push' | 'pull';
    sendTransaction: (call: SplitCall) => Promise<void>;
  };
  moderator?: string;
  fileId?: string;
  previewLen?: number;
  /** Store/host the encrypted file and its public header. Consume streamed files fully before resolving. Called after header authorization. */
  publish: (file: {
    file: import('../envelope/replay.js').SellFile<T>;
    header: Uint8Array;
    terms: Terms;
  }) => Promise<void>;
}
export interface BuyOptions {
  /** Explicit selection never falls back to another payment route. */
  route?: BuyRoute;
  baseUnlock?: 'relayer' | 'self';
  baseSponsorship?: BaseSponsorship;
  /** Persist the workflow association before an SDK write can become uncertain. */
  beforeSave?: (record: PurchaseRecord) => Promise<void>;
  /** Awaited after each durable purchase and backup write, before external effects. */
  onSaved?: (record: PurchaseRecord) => Promise<void>;
  /** Last durable UI checkpoint before payment submission or releasing deposit instructions. */
  beforePayment?: (record: PurchaseRecord) => Promise<void>;
  fileId: string;
  header: Uint8Array;
  recovery: IdentityWallet;
  refund: Identity;
  payer?: IdentityWallet;
  maxPrice: bigint;
  moderators?: readonly string[];
  paymentRequired?: PaymentRequired;
  url?: string;
  oneClick?: Pick<OneClick, 'quote'>;
  origin?: Origin;
  /** Review the live 1Click quote after its encrypted backup is saved, before recovery proof and deposit instructions. */
  onQuote?: (quote: OneClickQuote) => void | Promise<void>;
  /** Submit the saved Base payload to the host/facilitator. Return only after its request completes. */
  submitBase?: (header: string) => Promise<void>;
}
export interface Bought {
  route: BuyRoute;
  record: PurchaseRecord;
  instructions?: Deposit;
  uncertain?: { purchaseId: string; txHash: string };
  payment?: string;
}
