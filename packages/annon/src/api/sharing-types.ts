/** Types of hosted selling: share options, quotes, steps and the durable hosted checkpoint. */
import type {
  UploadAuth,
  UploadAuthorization,
  UploadBaseSplit,
  UploadIntent,
  UploadManifest,
  UploadMetadata,
  UploadPublished,
} from '../download/upload.js';
import type { SellData, Spool } from '../envelope/replay.js';
import type { FileInfo } from '../near/rpc.js';
import type { SellRecord } from '../pay/backup.js';
import type { ProtocolFee } from '../relay/fees.js';
import type { HostingReservation } from '../relay/reservation.js';
import type { Identity } from '../settle-near/identity.js';
import type { Terms } from '../settle-near/terms.js';
import type { IdentityWallet } from '../wallet/wallet.js';

export type ShareStep = 'stage' | 'split' | 'deposit' | 'register' | 'fund' | 'publish';
export interface ShareHosting {
  origin: string;
  /** Required only for a NEAR seller; signs the exact upload-specific NEP-413 payload. */
  signUpload?: (intent: UploadIntent) => Promise<UploadAuth>;
  /** Browsers supply a ciphertext Blob spool; Node supplies a disk spool. */
  spool?: Spool;
  body?: (
    source: import('../envelope/replay.js').ReplayableSource,
  ) => Promise<Blob | ReadableStream<Uint8Array>>;
}
export interface ShareOptions {
  data: SellData;
  name: string;
  mime: string;
  seller: IdentityWallet;
  /** USDC base units. The default split pays this seller. */
  price: string;
  near?: { recipients: { identity: Identity; bps: number }[]; remainder: Identity };
  title?: string;
  description?: string;
  hosting: ShareHosting;
  listingStorage?: bigint;
  storageBudget?: bigint;
  onSplit?: (
    near: Terms['near'],
    fee?: ProtocolFee,
    aboveMaximum?: boolean,
  ) => Promise<void> | void;
  /** Resolves only after the pending encrypted backup and separate secret are saved. */
  confirmBackup?: (backup: { fileId: string; text: string }) => Promise<void>;
}
export interface ShareQuote {
  quoteId: string;
  fileId: string;
  terms: Terms;
  fee: ProtocolFee | null;
  steps: ShareStep[];
  metadata: UploadMetadata;
  listingStorage: string | null;
  storageBudget: string | null;
}
export interface Shared extends UploadPublished {
  /** Hosting expiry in Unix seconds as stated by the shop, or null for no planned expiry. */
  expiresAt: number | null;
}
export interface HostedCheckpoint {
  origin: string;
  metadata: UploadMetadata;
  fee: ProtocolFee | null;
  intent: UploadIntent;
  manifest: UploadManifest;
  authorization: UploadAuthorization | null;
  uploadId: string | null;
  reservation: HostingReservation | null;
  split: UploadBaseSplit | null;
  steps: ShareStep[];
  completed: ShareStep[];
  pending: {
    step: ShareStep;
    token: string;
    txHash?: string;
    snapshot?: string;
    storageAccountExisted?: boolean;
    validUntil?: number;
    startedAt?: number;
    operation?: { method: string; args: object; deposit: string };
    auth?: import('../settle-near/identity.js').Authorization;
  } | null;
  lease: { owner: string; until: number } | null;
  backupConfirmed: boolean;
  listingStorage: string | null;
  header: string | null;
  result: Shared | null;
}
export type HostedSellRecord = SellRecord & { hosting: HostedCheckpoint };
export interface ShareContext {
  config(): Promise<{ network: string; nearUsdc: string; usdc: string }>;
  file(fileId: string): Promise<FileInfo | null>;
  call(method: string, args: object, wallet: IdentityWallet): Promise<unknown>;
  answer(value: unknown, secret: Uint8Array, fileId: string): Promise<Uint8Array>;
  reopen(fileId: string, seller: IdentityWallet): Promise<Uint8Array>;
}
