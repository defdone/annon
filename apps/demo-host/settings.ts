import { corsPolicy } from '../../packages/annon/src/download/http.ts';

/** Strict environment parsing; product ceilings may be tightened, never raised. */
export function settings(env: Record<string, string | undefined>) {
  const int = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name];
    if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error(`invalid ${name}`);
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`invalid ${name}`);
    return value;
  };
  const wei = (name: string, fallback: string) => {
    const raw = env[name] ?? fallback;
    if (!/^\d{1,80}$/.test(raw)) throw new Error(`invalid ${name}`);
    const value = BigInt(raw);
    if (value > BigInt(fallback)) throw new Error(`invalid ${name}`);
    return value;
  };
  const list = (name: string) =>
    env[name] === undefined
      ? undefined
      : env[name]
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  int('MAX_FILE_BYTES', 50_000_000, 1, 50_000_000);
  int('MAX_PAY2_BYTES', 50_086_016, 1, 50_086_016);
  int('MAX_HEADER_BYTES', 65536, 1, 65536);
  int('MAX_UPLOAD_JSON_BYTES', 131072, 1, 131072);
  int('DOWNLOAD_CONCURRENCY_PER_PURCHASE', 1, 1, 1);
  int('SPONSORED_FILES_LISTED_RESERVED', 0, 0, 0);
  const volume = int('HOST_VOLUME_BYTES', 100_000_000_000);
  const hostBytes = int(
    'HOST_DATA_BUDGET_BYTES',
    80_000_000_000,
    0,
    Math.min(volume, 80_000_000_000),
  );
  const low = env.FACILITATOR_ETH_LOW_WATER ?? '0.003';
  if (!/^\d+(\.\d{1,18})?$/.test(low)) throw new Error('invalid FACILITATOR_ETH_LOW_WATER');
  const [whole = '0', fraction = ''] = low.split('.');
  const fee = Number(env.MAX_FEE_GWEI ?? '0.5');
  if (!Number.isFinite(fee) || fee <= 0 || fee > 0.5) throw new Error('invalid MAX_FEE_GWEI');
  return {
    int,
    uploads: {
      idleSeconds: int('UPLOAD_IDLE_SECONDS', 600, 1, 600),
      stagingSeconds: int('UPLOAD_STAGING_SECONDS', 86400, 1, 86400),
      authSeconds: int('UPLOAD_AUTH_SECONDS', 600, 1, 600),
      reservationSeconds: int('UPLOAD_RESERVATION_SECONDS', 600, 600, 600),
      openPoolEnabled: int('OPEN_POOL_ENABLED', 1, 0, 1) === 1,
      maxFileBytes: int('MAX_FILE_BYTES', 50_000_000, 1, 50_000_000),
      maxPay2Bytes: int('MAX_PAY2_BYTES', 50_086_016, 1, 50_086_016),
      maxHeaderBytes: int('MAX_HEADER_BYTES', 65536, 1, 65536),
      filenameBytes: int('UPLOAD_FILENAME_BYTES', 255, 1, 255),
      titleBytes: int('UPLOAD_TITLE_BYTES', 120, 1, 120),
      descriptionBytes: int('UPLOAD_DESCRIPTION_BYTES', 500, 0, 500),
    },
    uploadHttp: {
      maxJsonBytes: int('MAX_UPLOAD_JSON_BYTES', 131072, 1, 131072),
      maxHeaderBytes: int('MAX_HEADER_BYTES', 65536, 1, 65536),
      authHeaderBytes: int('UPLOAD_AUTH_HEADER_BYTES', 8192, 1, 8192),
      idleSeconds: int('UPLOAD_IDLE_SECONDS', 600, 1, 600),
      requestSeconds: int('UPLOAD_REQUEST_SECONDS', 1800, 1, 1800),
    },
    maxFileBytes: int('MAX_FILE_BYTES', 50_000_000, 1, 50_000_000),
    maxPay2Bytes: int('MAX_PAY2_BYTES', 50_086_016, 1, 50_086_016),
    maxHeaderBytes: int('MAX_HEADER_BYTES', 65536, 1, 65536),
    perIpMinute: int('PER_IP_MINUTE', 600, 1, 600),
    paymentsPerClientMinute: int('PAYMENTS_PER_CLIENT_MINUTE', 60, 1, 60),
    sendsPerMinute: int('SENDS_PER_MINUTE', 10, 1, 10),
    maxFeeGwei: fee,
    rpcTimeout: int('BASE_RPC_TIMEOUT_MS', 5000),
    rpcRetries: int('BASE_RPC_RETRY_COUNT', 1, 0),
    gasLimit: BigInt(int('FACILITATOR_GAS_LIMIT', 120000, 1, 120000)),
    pollSeconds: int('SETTLEMENT_POLL_SECONDS', 10),
    graceSeconds: int('UNPAID_RECORD_GRACE_SECONDS', 86400),
    sampleSeconds: int('ALERT_SAMPLE_SECONDS', 60),
    diskPercent: int('ALERT_DISK_PERCENT', 70, 1, 100),
    sweepSeconds: int('UPLOAD_SWEEP_SECONDS', 60),
    cors: corsPolicy(
      list('CORS_ALLOW_ORIGINS'),
      list('CORS_PREVIEW_ORIGINS'),
      'host',
      int('CORS_MAX_AGE_SECONDS', 600, 0, 600),
    ),
    capacity: {
      maxFileBytes: int('MAX_FILE_BYTES', 50_000_000, 1, 50_000_000),
      maxPay2Bytes: int('MAX_PAY2_BYTES', 50_086_016, 1, 50_086_016),
      hostBytes,
      poolBytes: int('POOL_STORAGE_BYTES', 40_000_000_000, 0, Math.min(hostBytes, 40_000_000_000)),
      ingressPerDay: int('UPLOAD_BYTES_PER_DAY', 1_000_000_000, 0, 1_000_000_000),
      filesPerDay: int('SPONSORED_FILES_PER_DAY', 30, 0, 30),
      filesPerIpDay: int('SPONSORED_FILES_PER_IP_DAY', 3, 0, 3),
      filesPerSellerDay: int('REGISTRATIONS_PER_SELLER_DAY', 3, 0, 3),
      listedPerSellerDay: int('LISTED_REGISTRATIONS_PER_SELLER_DAY', 20, 0, 20),
      ttlSeconds: int('UPLOAD_TTL_SECONDS', 604800, 1, 604800),
      stagingSeconds: int('UPLOAD_STAGING_SECONDS', 86400, 1, 86400),
      idleSeconds: int('UPLOAD_IDLE_SECONDS', 600, 1, 600),
      concurrency: int('UPLOAD_CONCURRENCY', 4, 0, 4),
      perSeller: int('UPLOADS_PER_SELLER', 1, 0, 1),
      perIp: int('UPLOADS_PER_IP', 1, 0, 1),
      canonicalFileId: env.CANONICAL_DEMO_FILE_ID,
      canonicalSlug: 'what-we-are-building',
    },
    downloads: {
      immediateCount: int('DOWNLOAD_IMMEDIATE_COUNT', 3, 1, 3),
      fourthWaitSeconds: int('DOWNLOAD_FOURTH_WAIT_SECONDS', 900, 900),
      fifthWaitSeconds: int('DOWNLOAD_FIFTH_WAIT_SECONDS', 7200, 7200),
      laterWaitSeconds: int('DOWNLOAD_LATER_WAIT_SECONDS', 86400, 86400),
      resumeSeconds: int('DOWNLOAD_RESUME_SECONDS', 600, 1, 600),
      attemptSeconds: int('DOWNLOAD_ATTEMPT_SECONDS', 1800, 1, 1800),
      busyRetrySeconds: int('DOWNLOAD_BUSY_RETRY_SECONDS', 5),
    },
    facilitator: {
      maxWaiting: int('FACILITATOR_MAX_WAITING', 16, 0, 16),
      minValiditySeconds: int('PAYMENT_MIN_VALIDITY_SECONDS', 60, 60),
      simulationMarginSeconds: int('PAYMENT_SIMULATION_MARGIN_SECONDS', 30, 30),
      payerRevertsPerDay: int('FACILITATOR_PAYER_REVERTS_PER_DAY', 1, 0, 1),
      revertsPerDay: int('FACILITATOR_REVERTS_PER_DAY', 10, 0, 10),
      dailyGasBudgetWei: wei('FACILITATOR_DAILY_GAS_BUDGET_WEI', '1000000000000000'),
      stuckSeconds: int('FACILITATOR_STUCK_SECONDS', 120, 1, 120),
      ethLowWaterWei: BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')),
      waitAlertSeconds: int('ALERT_FACILITATOR_WAIT_SECONDS', 15),
    },
  };
}
