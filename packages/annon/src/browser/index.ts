/** Browser purchase logic. The embedding application supplies its own screen and wallets. */

export {
  Annon,
  type AnnonOptions,
  type BuyOptions,
  type BuyRoute,
  SellError,
} from '../api/annon.js';
export { DownloadError, type DownloadErrorCode } from '../download/download.js';
export { Pay2Error, type Pay2ErrorCode } from '../envelope/pay2.js';
export { SourceChangedError } from '../envelope/stream.js';
export { CkdError, type CkdErrorCode } from '../keys/near-ckd.js';
export { NearError, type NearErrorCode, NearRpcRateLimited } from '../near/rpc.js';
export {
  type Deposit,
  OneClick,
  type OneClickQuote,
  OneClickQuoteExpired,
  OneClickRefused,
  type Origin,
  originFromToken,
  type PollCheckpoint,
  type PollOptions,
  type QuotePreview,
  type SwapStatus,
  type Token,
  validateRefundAddress,
} from '../oneclick/oneclick.js';
export { newBackupSecret } from '../pay/backup.js';
export { BaseRpcRateLimited, PayError, type PayErrorCode } from '../pay/base.js';
export { TransactionUncertain } from '../wallet/uncertain.js';
export {
  type EvmWallet,
  FileFundingRefused,
  type IdentityWallet,
  type NearWallet,
} from '../wallet/wallet.js';
export {
  BROWSER_DOWNLOAD_LIMIT,
  type BrowserDownloadOptions,
  type BrowserDownloadProgress,
  browserDownload,
} from './download.js';
export {
  type BrowserOpenOptions,
  BrowserPurchaseController,
  type BrowserPurchaseRecord,
  type BrowserPurchaseState,
  type BrowserPurchaseStorage,
  browserAnnon,
  browserPurchaseStorage,
  type ControllerOptions,
  PurchaseLeaseBusy,
  type PurchaseProgress,
  type PurchaseSdk,
  type PurchaseTermsReview,
} from './purchases.js';
export {
  type BrowserNearProvider,
  type BrowserNearTransaction,
  BrowserWalletError,
  type BrowserWalletErrorCode,
  browserEvmWallet,
  browserNearWallet,
  browserSolanaWallet,
  type InjectedEvmProvider,
  type InjectedSolanaKey,
  type InjectedSolanaProvider,
} from './wallets.js';
