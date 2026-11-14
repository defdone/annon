/** Relayer configuration types and environment parsing. */

import { parseIdentity } from '@defdone/annon';
import type { RefundSource } from '@defdone/annon/relay';
import { type CheckOptions, NEAR_USDC, type Sender } from '@defdone/annon/relay';
import type { MonitorSettings, ServiceMonitor } from './alerts.ts';
import { type CorsSettings, relayerCorsPolicy } from './http.ts';
import { webhookUrl } from './monitoring.ts';

export interface Config extends Omit<CheckOptions, 'now'> {
  sender: Sender;
  stateDir?: string;
  archivalRpc?: string;
  cors?: CorsSettings;
  monitorSettings?: MonitorSettings;
  monitor?: ServiceMonitor;
  keeperLastSuccess?: number;
  keeper?: {
    sender: Sender;
    stateDir: string;
    hourlyBudget: bigint;
    dailyBudget: bigint;
    gasPrice: bigint;
    reserveLowWater: bigint;
    minPayout?: bigint;
    balanceLowWater?: bigint;
    alertWebhook?: string;
    refunds?: RefundSource;
  };
  /** Kill switch: answer 503 and send nothing. */
  disabled: boolean;
  /** New admissions per client per hour, and default daily capacity of each method pool. */
  sponsoredFilesPerIpDay?: number;
  perIpHour: number;
  perDay: number;
  unlockReserved?: number;
  unlockListedReserved?: number;
  perMethodDay?: Partial<Record<string, number>>;
  hitsCap?: number;
  requestMultiplier?: number;
  retrySeconds?: number;
  balanceLowWater?: bigint;
  storageLowWater?: bigint;
  alertWebhook?: string;
  /** The header a trusted proxy puts the client's IP in; without one, the connection's address. */
  ipHeader?: string;
}

/** The settings from the environment (apps/relayer/README.md); throws on a missing or bad one. */
export function fromEnv(e: Record<string, string | undefined>): {
  config: Config;
  port: number;
  keeperSeconds: number;
} {
  const env = (name: string, fallback?: string) => {
    const v = e[name]?.trim() || fallback;
    if (v === undefined) throw new Error(`${name} is not set`);
    return v;
  };
  // A typo stops the start instead of turning a limit off.
  const count = (name: string, fallback: string) => {
    const n = Number(env(name, fallback));
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
  };
  const flag = (name: string, fallback: string) => {
    const v = env(name, fallback);
    if (!['0', '1'].includes(v)) throw new Error(`${name} must be 0 or 1`);
    return v === '1';
  };
  const https = (value: string, name: string) => {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw new Error(`${name} must be HTTPS`);
    return value;
  };
  const origin = (value: string) => {
    https(value, 'DEMO_HOST_ORIGIN');
    if (new URL(value).origin !== value) throw new Error('DEMO_HOST_ORIGIN must be an origin');
    return value;
  };
  const list = (name: string, fallback: string) =>
    (e[name] ?? fallback)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  relayerCorsPolicy({
    allow: list('CORS_ALLOW_ORIGINS', 'https://annon.dev,https://www.annon.dev'),
    previews: list('CORS_PREVIEW_ORIGINS', ''),
  });
  if (e.IP_HEADER && !/^[a-z0-9-]{1,64}$/i.test(e.IP_HEADER.trim()))
    throw new Error('IP_HEADER is invalid');
  if (e.DEMO_RESERVATION_PUBLIC_KEY && !/^[0-9a-f]{64}$/.test(e.DEMO_RESERVATION_PUBLIC_KEY))
    throw new Error('DEMO_RESERVATION_PUBLIC_KEY is invalid');
  if (
    count('BASE_ELIGIBILITY_MAX_AGE_SECONDS', '30') !== 30 ||
    count('SPONSORED_FILES_LISTED_RESERVED', '0') !== 0
  )
    throw new Error('Invalid fixed sponsorship setting');
  for (const [name, maximum] of Object.entries({
    MAX_FILE_BYTES: 50000000,
    MAX_DEADLINE_SECONDS: 600,
    TOPUP_MAX_DEADLINE_SECONDS: 600,
    SPONSORED_FILES_PER_DAY: 60,
    SPONSORED_FILES_PER_IP_DAY: 2,
    REGISTRATIONS_PER_SELLER_DAY: 2,
    LISTED_REGISTRATIONS_PER_SELLER_DAY: 20,
    CORS_MAX_AGE_SECONDS: 600,
  })) {
    if (count(name, String(maximum)) > maximum) throw new Error(`${name} exceeds its maximum`);
  }
  for (const [name, fallback] of Object.entries({
    PORT: 8080,
    MAX_DEADLINE_SECONDS: 600,
    TOPUP_MAX_DEADLINE_SECONDS: 600,
    HOLD_SECONDS: 900,
    RETRY_SECONDS: 5,
    HITS_CAP: 100000,
    ALERT_SAMPLE_SECONDS: 60,
    ALERT_KEEPER_STALLED_SECONDS: 300,
    ALERT_OLDEST_DELIVERY_SECONDS: 1800,
    ALERT_RELAYER_429_WINDOW_SECONDS: 600,
  })) {
    if (count(name, String(fallback)) === 0) throw new Error(`${name} must be positive`);
  }
  if (count('MIN_PRICE', '100000') === 0) throw new Error('MIN_PRICE must be positive');
  const sellers = e.SELLERS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const separator = s.indexOf(':');
      return JSON.stringify(
        parseIdentity({ kind: s.slice(0, separator), id: s.slice(separator + 1) }),
      );
    });
  env('RELAYER_STATE_DIR');
  env('DEMO_HOST_ORIGIN');
  if (flag('OPEN_POOL_ENABLED', '1') && !sellers?.length)
    throw new Error('SELLERS is required for the demo pool');
  const keeperSeconds = count('KEEPER_SECONDS', '0');
  const yocto = (name: string, fallback?: string) => {
    const value = env(name, fallback);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be yoctoNEAR`);
    return BigInt(value);
  };
  const nearAmount = (name: string, fallback: string) => {
    const value = env(name, fallback);
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(value)) throw new Error(`${name} must be NEAR`);
    const [whole = '0', fraction = ''] = value.split('.');
    const amount = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
    if (amount >= 2n ** 128n) throw new Error(`${name} too large`);
    return amount;
  };
  for (const [name, maximum] of Object.entries({
    FILE_BUDGET: '0.041',
    LISTED_FILE_BUDGET: '0.05',
    TOPUP_PER_FILE: '0.082',
    TOPUP_PER_FILE_DAY: '0.041',
    LISTED_TOPUP_PER_FILE: '0.15',
    LISTED_TOPUP_PER_FILE_DAY: '0.05',
    TOPUP_PER_DAY: '0.5',
  })) {
    const [whole = '0', fraction = ''] = maximum.split('.');
    const cap = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
    if (nearAmount(name, maximum) > cap) throw new Error(`${name} exceeds its maximum`);
  }
  if (nearAmount('PREPAID_UNLOCK_FLOOR', '1') < 10n ** 24n)
    throw new Error('PREPAID_UNLOCK_FLOOR must protect at least 1 NEAR');
  if (e.ADMISSION_FLOOR_NEAR !== undefined && !e.ADMISSION_FLOOR_NEAR.trim())
    throw new Error('invalid ADMISSION_FLOOR_NEAR');
  const admissionFloor = nearAmount('ADMISSION_FLOOR_NEAR', '3');
  if (admissionFloor <= 0n) throw new Error('ADMISSION_FLOOR_NEAR must be positive');
  const treasury = (name: string) => {
    const value = e[name]?.trim();
    if (!value) return null;
    const at = value.indexOf(':');
    const identity = parseIdentity(
      at < 0
        ? { kind: name === 'TREASURY_EVM' ? 'evm' : 'near', id: value }
        : { kind: value.slice(0, at), id: value.slice(at + 1) },
    );
    if (name === 'TREASURY_EVM' && identity.kind !== 'evm')
      throw new Error('TREASURY_EVM must be EVM');
    return identity;
  };
  if (count('FEE_BPS', '100') >= 10000) throw new Error('FEE_BPS must be below 10000');
  const treasuryNear = treasury('TREASURY_NEAR');
  const treasuryEvm = treasury('TREASURY_EVM');
  const baseSetting = env('BASE_SPONSORSHIP', '1');
  if (!['0', '1'].includes(baseSetting)) throw new Error('BASE_SPONSORSHIP must be 0 or 1');
  const baseSponsorship = baseSetting === '1';
  if (
    (yocto('FEE_FIXED', '30000') > 0n || count('FEE_BPS', '100') > 0) &&
    !treasuryNear &&
    !treasuryEvm
  )
    throw new Error('fees require a treasury');
  if (baseSponsorship && !treasuryEvm) throw new Error('Base sponsorship requires TREASURY_EVM');
  if (yocto('FEE_FIXED', '30000') < 30000n)
    throw new Error('FEE_FIXED cannot discount sponsorship');
  if (count('FEE_BPS', '100') < 100) throw new Error('FEE_BPS cannot discount sponsorship');
  if (count('MIN_PRICE', '100000') < 100000)
    throw new Error('MIN_PRICE is below the sponsorship minimum');
  const keeperConfig =
    keeperSeconds > 0
      ? {
          sender: { accountId: env('KEEPER_ACCOUNT'), key: env('KEEPER_KEY') },
          stateDir: env('KEEPER_STATE_DIR'),
          hourlyBudget: yocto('KEEPER_HOURLY_BUDGET', '500000000000000000000000'),
          dailyBudget: yocto('KEEPER_DAILY_BUDGET', '1000000000000000000000000'),
          gasPrice: yocto('KEEPER_GAS_PRICE', '100000000'),
          minPayout: yocto('KEEPER_MIN_PAYOUT', '100000'),
          reserveLowWater: yocto('KEEPER_RESERVE_LOW_WATER', '40960000000000000000000'),
          balanceLowWater: yocto('KEEPER_BALANCE_LOW_WATER', '2000000000000000000000000'),
          ...(e.KEEPER_ALERT_WEBHOOK?.trim()
            ? { alertWebhook: webhookUrl(e.KEEPER_ALERT_WEBHOOK.trim()) }
            : {}),
        }
      : undefined;
  if (
    keeperConfig &&
    (keeperConfig.sender.accountId === env('RELAYER_ACCOUNT') ||
      keeperConfig.sender.key === env('RELAYER_KEY'))
  )
    throw new Error('keeper requires a separate account and key');
  const contractId = env('CONTRACT_ID');

  const perDay = count('PER_DAY', '1000');
  const unlockReserved = count('UNLOCK_RESERVED', String(Math.min(500, perDay)));
  if (unlockReserved > perDay) throw new Error('UNLOCK_RESERVED cannot exceed PER_DAY');
  return {
    config: {
      nearRpc: env('NEAR_RPC', 'https://rpc.mainnet.fastnear.com'),
      baseRpc: env('BASE_RPC', 'https://mainnet.base.org'),
      contractId,
      stateDir: env('RELAYER_STATE_DIR'),
      network: env('NETWORK', 'near:mainnet'),
      nearUsdc: env('NEAR_USDC', NEAR_USDC),
      ...(e.NEAR_ARCHIVAL_RPC?.trim()
        ? { archivalRpc: https(e.NEAR_ARCHIVAL_RPC.trim(), 'NEAR_ARCHIVAL_RPC') }
        : {}),
      cors: {
        allow: list('CORS_ALLOW_ORIGINS', 'https://annon.dev,https://www.annon.dev'),
        previews: list('CORS_PREVIEW_ORIGINS', ''),
        maxAgeSeconds: count('CORS_MAX_AGE_SECONDS', '600'),
      },
      reservation: {
        hostOrigin: origin(env('DEMO_HOST_ORIGIN')),
        publicKey: env('DEMO_RESERVATION_PUBLIC_KEY', ''),
        maxFileBytes: count('MAX_FILE_BYTES', '50000000'),
      },
      monitorSettings: {
        sampleSeconds: count('ALERT_SAMPLE_SECONDS', '60'),
        poolPercent: count('ALERT_POOL_PERCENT', '70'),
        diskPercent: count('ALERT_DISK_PERCENT', '70'),
        stalledSeconds: count('ALERT_KEEPER_STALLED_SECONDS', '300'),
        oldestSeconds: count('ALERT_OLDEST_DELIVERY_SECONDS', '1800'),
        refusals: count('ALERT_RELAYER_429_COUNT', '20'),
        refusalWindowSeconds: count('ALERT_RELAYER_429_WINDOW_SECONDS', '600'),
        keeperBudgetPercent: count('ALERT_KEEPER_BUDGET_PERCENT', '50'),
      },
      usdc: env('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      sender: { accountId: env('RELAYER_ACCOUNT'), key: env('RELAYER_KEY') },
      policy: {
        minPrice: BigInt(count('MIN_PRICE', '100000')),
        baseSponsorship,
        openPoolEnabled: flag('OPEN_POOL_ENABLED', '1'),
        listedRegistrationsPerSeller: count('LISTED_REGISTRATIONS_PER_SELLER_DAY', '20'),
        unlocksPerFile: count('UNLOCKS_PER_FILE_DAY', '10'),
        unlocksPerSeller: count('UNLOCKS_PER_SELLER_DAY', '20'),
        listedUnlocksPerFile: count('LISTED_UNLOCKS_PER_FILE_DAY', '100'),
        listedUnlocksPerSeller: count('LISTED_UNLOCKS_PER_SELLER_DAY', '250'),
        listedTopupPerFile: nearAmount('LISTED_TOPUP_PER_FILE', '0.15'),
        listedTopupPerFileDay: nearAmount('LISTED_TOPUP_PER_FILE_DAY', '0.05'),
        topupListedReserved: nearAmount('TOPUP_LISTED_RESERVED', '0.25'),
        prepaidUnlockFloor: nearAmount('PREPAID_UNLOCK_FLOOR', '1'),
        storagePerWrite: nearAmount('STORAGE_PER_WRITE', '0.01'),
        topupMaxDeadlineSeconds: count('TOPUP_MAX_DEADLINE_SECONDS', '600'),
        fileBudget: nearAmount('FILE_BUDGET', '0.041'),
        listedFileBudget: nearAmount('LISTED_FILE_BUDGET', '0.05'),
        sponsoredFilesPerDay: count('SPONSORED_FILES_PER_DAY', '60'),
        topupPerFile: nearAmount('TOPUP_PER_FILE', '0.082'),
        topupPerFileDay: nearAmount('TOPUP_PER_FILE_DAY', '0.041'),
        topupPerDay: nearAmount('TOPUP_PER_DAY', '0.5'),
        fee: {
          fixed: yocto('FEE_FIXED', '30000').toString(),
          bps: count('FEE_BPS', '100'),
          treasuryNear,
          treasuryEvm,
        },
        maxDeadlineSeconds: count('MAX_DEADLINE_SECONDS', '600'),
        claimsPerGrant: count('CLAIMS_PER_GRANT_DAY', '3'),
        registrationsPerSeller: count('REGISTRATIONS_PER_SELLER_DAY', '2'),
        reopensPerWalletFile: count('REOPENS_PER_PURCHASE_DAY', '10'),
        holdMs: count('HOLD_SECONDS', '900') * 1000,
        maxWaiting: count('MAX_WAITING', '32'),
        maxChecking: count('MAX_CHECKING', '32'),
        ...(sellers?.length ? { sellerAllowed: (s: string) => sellers.includes(s) } : {}),
      },
      ...(keeperConfig ? { keeper: keeperConfig } : {}),
      disabled: flag('DISABLED', '0'),
      sponsoredFilesPerIpDay: count('SPONSORED_FILES_PER_IP_DAY', '2'),
      perIpHour: count('PER_IP_HOUR', '600'),
      perDay,
      unlockReserved,
      unlockListedReserved: count('UNLOCK_LISTED_RESERVED', '250'),
      perMethodDay: Object.fromEntries(
        [
          'register',
          'unlock',
          'claim_key',
          'reopen',
          'reopen_seller',
          'stop_sales',
          'fund_file_storage',
        ].map((m) => [
          m,
          count(
            `PER_DAY_${m.toUpperCase()}`,
            String(
              (
                {
                  register: 100,
                  unlock: 500,
                  claim_key: 250,
                  reopen: 50,
                  reopen_seller: 50,
                  stop_sales: 100,
                  fund_file_storage: 50,
                } as Record<string, number>
              )[m],
            ),
          ),
        ]),
      ),
      hitsCap: Math.max(1, count('HITS_CAP', '100000')),
      requestMultiplier: count('REQUEST_MULTIPLIER', '10'),
      retrySeconds: count('RETRY_SECONDS', '5'),
      admissionFloor,
      balanceLowWater: yocto('RELAYER_BALANCE_LOW_WATER', '3000000000000000000000000'),
      storageLowWater: yocto('RELAYER_STORAGE_LOW_WATER', '500000000000000000000000'),
      ...(e.RELAYER_ALERT_WEBHOOK?.trim()
        ? { alertWebhook: webhookUrl(e.RELAYER_ALERT_WEBHOOK.trim()) }
        : {}),
      ...(e.IP_HEADER?.trim() ? { ipHeader: e.IP_HEADER.trim().toLowerCase() } : {}),
    },
    port: count('PORT', '8080'),
    keeperSeconds,
  };
}
