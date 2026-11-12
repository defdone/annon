import type { BuyRoute } from '../api/annon.js';
import type { PollCheckpoint } from '../oneclick/oneclick.js';
import type { RecoveryRecord } from './backup.js';
import type { PurchaseRecord } from './purchase.js';
import type { Versioned } from './store.js';

export const purchaseStates = [
  'terms_review',
  'preparing',
  'payment_uncertain',
  'awaiting_deposit',
  'incomplete_deposit',
  'processing',
  'accepting',
  'accepted',
  'recovering',
  'file_ready',
  'refunded',
  'failed',
  'expired',
  'abandoned',
] as const;
export type BrowserPurchaseState = (typeof purchaseStates)[number];
export interface BrowserPurchaseRecord extends Versioned {
  fileId: string;
  header: string;
  resourceUrl: string;
  route: BuyRoute;
  maxPrice: string;
  state: BrowserPurchaseState;
  purchase?: PurchaseRecord;
  recovery?: RecoveryRecord;
  recoveryArchives?: RecoveryRecord[];
  paymentStarted?: boolean;
  lease?: { owner: string; expiresAt: number } | undefined;
  checkpoint?: PollCheckpoint;
  /** Imported receipts require a fresh ownership proof before deposit instructions. */
  needsProof?: boolean;
  /** Set durably before entering a payment submission boundary. Missing on older records. */
  submission?: 'not_submitted' | 'uncertain' | 'submitted';
}
export interface BrowserIndex extends Versioned {
  kind: 'browser-index';
  entries: BrowserPurchaseRecord[];
  backups: Record<string, string>;
}

/** Durable metadata only. Full workflow records live under their own keys. */
export interface BrowserIndexEntry extends Versioned {
  fileId: string;
  route: BuyRoute;
  state: BrowserPurchaseState;
  resourceUrl: string;
  purchaseId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface BrowserPurchaseIndex extends Versioned {
  kind: 'browser-purchase-index';
  entries: BrowserIndexEntry[];
}
export interface StoredBrowserPurchase extends BrowserPurchaseRecord {
  kind: 'browser-purchase';
}

export interface BrowserRecoveryArchiveIndex extends Versioned {
  kind: 'browser-recovery-archives';
  purchaseId: string;
  names: string[];
}
