import { authorizationCall, PayError } from '../../packages/annon/src/pay/base.ts';
import type { Authorization } from '../../packages/annon/src/pay/eip3009.ts';
import type { Facilitator } from '../../packages/annon/src/pay/settle.ts';
import { memoryStore, type Store, type Versioned } from '../../packages/annon/src/pay/store.ts';
import { BASE_USDC } from '../../packages/annon/src/settle-near/terms.ts';
import { type Alert, emit } from './alerts.ts';
import { StartupError } from './startup-errors.ts';

export interface Chain {
  timestamp(): Promise<number>;
  used(from: string, nonce: string): Promise<boolean>;
  balance(from: string): Promise<bigint>;
  simulate(a: Authorization, signature: string, timestamp: number): Promise<boolean>;
  sign(
    to: string,
    data: string,
  ): Promise<{ serialized: string; hash: string; maxCostWei: bigint } | null>;
  send(signed: string): Promise<string>;
  receipt(hash: string): Promise<{ reverted: boolean; costWei: bigint } | null>;
  transaction(hash: string): Promise<boolean>;
  ethBalance(): Promise<bigint>;
  nonceClear(): Promise<boolean>;
}
interface Send {
  hash: string;
  payer: string;
  at: number;
  until: number;
  day: number;
  cost: string;
  done: boolean;
}
interface Day {
  cost: string;
  reverts: number;
  payers: Record<string, number>;
}
export interface FacilitatorState extends Versioned {
  sends: Record<string, Send>;
  days: Record<string, Day>;
  times: number[];
}
export interface FacilitatorOptions {
  store?: Store<FacilitatorState>;
  alert?: Alert;
  maxWaiting?: number;
  minValiditySeconds?: number;
  simulationMarginSeconds?: number;
  dailyGasBudgetWei?: bigint;
  payerRevertsPerDay?: number;
  revertsPerDay?: number;
  stuckSeconds?: number;
  ethLowWaterWei?: bigint;
  waitAlertSeconds?: number;
  requireState?: boolean;
  rpcTimeout?: number;
  rpcRetries?: number;
  gasLimit?: bigint;
}

export async function initFacilitatorState(store: Store<FacilitatorState>, requireState = false) {
  const old = await store.load('facilitator');
  if (!old) {
    if (requireState) throw new StartupError('state_missing');
    if (
      !(await store.compareAndSet('facilitator', null, {
        id: 'facilitator',
        revision: 0,
        sends: {},
        days: {},
        times: [],
      }))
    )
      throw new StartupError('state_invalid');
  } else if (
    old.id !== 'facilitator' ||
    !Number.isSafeInteger(old.revision) ||
    old.revision < 0 ||
    !old.sends ||
    !old.days ||
    !Array.isArray(old.times)
  )
    throw new StartupError('state_invalid');
}

/** Read-only chain checks run before the bounded wallet queue. Prepared sends remain charged. */
export function facilitatorFor(
  chain: Chain,
  sendsPerMinute = 10,
  now = Date.now,
  options: FacilitatorOptions = {},
): Facilitator & { sample(): Promise<void> } {
  const store = options.store ?? memoryStore<FacilitatorState>();
  const key = 'facilitator';
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const transaction = async <T>(fn: (state: FacilitatorState) => T): Promise<T> => {
    for (let i = 0; i < 32; i++) {
      const old = await store.load(key);
      if (!old && options.requireState) throw new Error('facilitator state is missing');
      const state = old
        ? structuredClone(old)
        : { id: key, revision: -1, sends: {}, days: {}, times: [] };
      const result = fn(state);
      state.revision++;
      if (await store.compareAndSet(key, old, state)) return result;
    }
    emit(options.alert, { type: 'store_busy' });
    throw new Error('facilitator state is busy');
  };
  const day = (s: FacilitatorState, n: number): Day =>
    (s.days[n] ??= { cost: '0', reverts: 0, payers: {} });
  const sample = async () => {
    const balance = await chain.ethBalance();
    if (balance < (options.ethLowWaterWei ?? 3_000_000_000_000_000n))
      emit(options.alert, { type: 'facilitator_low_eth', balance: String(balance) });
    const old = await store.load(key);
    const receipts = await Promise.all(
      Object.entries(old?.sends ?? {})
        .filter(([, r]) => !r.done)
        .map(async ([id, r]) => {
          const receipt = await chain.receipt(r.hash);
          const nonce = id.slice(id.indexOf(':') + 1);
          const dropped =
            !receipt &&
            now() > r.until * 1000 + 600_000 &&
            (await chain.nonceClear()) &&
            !(await chain.used(r.payer, nonce)) &&
            !(await chain.transaction(r.hash));
          return { id, receipt, dropped };
        }),
    );
    await transaction((s) => {
      for (const { id, receipt, dropped } of receipts) {
        const r = s.sends[id];
        if (!r || r.done || (!receipt && !dropped)) continue;
        if (dropped) emit(options.alert, { type: 'facilitator_dropped' });
        const actual = receipt?.costWei ?? 0n;
        const d = day(s, r.day);
        d.cost = String(BigInt(d.cost) - BigInt(r.cost) + actual);
        r.cost = String(actual);
        r.done = true;
        if (receipt?.reverted) {
          d.reverts++;
          d.payers[r.payer] = (d.payers[r.payer] ?? 0) + 1;
          emit(options.alert, { type: 'facilitator_revert', count: d.reverts });
        }
      }
      for (const [id, r] of Object.entries(s.sends)) {
        if (!r.done && now() - r.at >= (options.stuckSeconds ?? 120) * 1000)
          emit(options.alert, {
            type: 'facilitator_stuck',
            seconds: Math.floor((now() - r.at) / 1000),
          });
        if (r.done && now() > r.until * 1000 + 86_400_000 && r.day < Math.floor(now() / 86_400_000))
          delete s.sends[id];
      }
      s.times = s.times.filter((t) => now() - t < 60_000);
    });
  };
  const facilitate: Facilitator = async (body, o) => {
    const req = body.paymentRequirements;
    const payload = (
      body.paymentPayload as unknown as {
        payload: {
          authorization: {
            from: string;
            to: string;
            value: string;
            validAfter: string;
            validBefore: string;
            nonce: string;
          };
          signature: string;
        };
      }
    ).payload;
    const a = payload.authorization;
    const fail = (errorReason: string, transaction = '') => ({
      success: false,
      errorReason,
      transaction,
      network: 'eip155:8453',
      payer: a.from,
      submissionAttempted: transaction !== '',
    });
    if (
      req.network !== 'eip155:8453' ||
      req.asset.toLowerCase() !== BASE_USDC ||
      a.to.toLowerCase() !== req.payTo.toLowerCase() ||
      BigInt(a.value) !== BigInt(req.amount)
    )
      return fail('invalid_authorization');
    const auth: Authorization = {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    };
    const id = `${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`;
    o.signal.throwIfAborted();
    await sample();
    const initial = await store.load(key);
    const known = initial?.sends[id];
    if (known) return fail('settlement_pending', known.hash);
    const entered = now();
    const [timestamp, used, balance, nonceClear] = await Promise.all([
      chain.timestamp(),
      chain.used(a.from, a.nonce),
      chain.balance(a.from),
      chain.nonceClear(),
    ]);
    if (auth.validBefore < BigInt(timestamp + (options.minValiditySeconds ?? 60)))
      return fail('payment_expired');
    if (auth.validAfter > BigInt(timestamp) || auth.value <= 0n)
      return fail('invalid_authorization');
    if (used) return fail('authorization_used');
    if (balance < auth.value) return fail('invalid_authorization');
    if (
      !(await chain.simulate(
        auth,
        payload.signature,
        timestamp + (options.simulationMarginSeconds ?? 30),
      ))
    )
      return fail('invalid_authorization');
    // One in progress plus a bounded number waiting. No chain preflight occupies this queue.
    if (waiting >= (options.maxWaiting ?? 16) + 1) {
      emit(options.alert, { type: 'facilitator_busy' });
      return fail('facilitator_busy');
    }
    waiting++;
    const run = async () => {
      o.signal.throwIfAborted();
      if (now() - entered > (options.waitAlertSeconds ?? 15) * 1000)
        emit(options.alert, {
          type: 'facilitator_wait',
          seconds: Math.floor((now() - entered) / 1000),
        });
      if (
        auth.validBefore <
        BigInt(timestamp + Math.ceil((now() - entered) / 1000) + (options.minValiditySeconds ?? 60))
      )
        return fail('payment_expired');
      const s = await store.load(key);
      if (!s) throw new Error('facilitator state is missing');
      const repeated = s.sends[id];
      if (repeated) return fail('settlement_pending', repeated.hash);
      const d = day(s, Math.floor(now() / 86_400_000));
      if ((d.payers[a.from.toLowerCase()] ?? 0) >= (options.payerRevertsPerDay ?? 1))
        return fail('payment_rejected');
      if (d.reverts >= (options.revertsPerDay ?? 10)) {
        emit(options.alert, { type: 'facilitator_revert', count: d.reverts });
        return fail('unavailable');
      }
      if (Object.values(s.sends).some((r) => !r.done) || !nonceClear)
        return fail('facilitator_busy');
      if (
        Object.values(s.sends).some(
          (r) => r.payer === a.from.toLowerCase() && now() - r.at < 30_000,
        )
      )
        return fail('payer_busy');
      if (s.times.filter((t) => now() - t < 60_000).length >= sendsPerMinute)
        return fail('facilitator_busy');
      const signed = await chain.sign(BASE_USDC, authorizationCall(auth, payload.signature));
      if (!signed) return fail('gas_price_too_high');
      o.signal.throwIfAborted();
      const admitted = await transaction((state) => {
        const current = day(state, Math.floor(now() / 86_400_000));
        if (
          BigInt(current.cost) + signed.maxCostWei >
          (options.dailyGasBudgetWei ?? 1_000_000_000_000_000n)
        )
          return false;
        current.cost = String(BigInt(current.cost) + signed.maxCostWei);
        state.sends[id] = {
          hash: signed.hash,
          payer: a.from.toLowerCase(),
          at: now(),
          until: Number(auth.validBefore),
          day: Math.floor(now() / 86_400_000),
          cost: String(signed.maxCostWei),
          done: false,
        };
        state.times.push(now());
        return true;
      });
      if (!admitted) {
        emit(options.alert, { type: 'facilitator_budget' });
        return {
          ...fail('unavailable'),
          retryAfterSeconds: Math.ceil((86_400_000 - (now() % 86_400_000)) / 1000),
        };
      }
      // The signed hash and cost reservation are durable before a broadcast can become uncertain.
      const hash = await chain.send(signed.serialized);
      if (hash !== signed.hash) throw new Error('transaction hash mismatch');
      return fail('settlement_pending', hash);
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    try {
      return await next;
    } finally {
      waiting--;
    }
  };
  return Object.assign(facilitate, { sample });
}

/** Base RPC adapter, with bounded transport and a forward timestamp simulation. */
export async function baseFacilitator(
  key: string,
  baseRpc: string,
  maxFeeGwei: number,
  sendsPerMinute: number,
  options: FacilitatorOptions = {},
) {
  const {
    createPublicClient,
    createWalletClient,
    http,
    parseGwei,
    parseAbi,
    keccak256,
    ExecutionRevertedError,
  } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { base } = await import('viem/chains');
  const { estimateL1Fee } = await import('viem/op-stack');
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  const transport = http(baseRpc, {
    timeout: options.rpcTimeout ?? 5000,
    retryCount: options.rpcRetries ?? 1,
  });
  const wallet = createWalletClient({ account, chain: base, transport });
  const pub = createPublicClient({ chain: base, transport });
  const abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function authorizationState(address,bytes32) view returns (bool)',
  ]);
  const address = BASE_USDC as `0x${string}`;
  const facilitator = facilitatorFor(
    {
      timestamp: async () => {
        if ((await pub.getChainId()) !== 8453) throw new PayError('network_mismatch');
        return Number((await pub.getBlock()).timestamp);
      },
      used: (from, nonce) =>
        pub.readContract({
          address,
          abi,
          functionName: 'authorizationState',
          args: [from as `0x${string}`, nonce as `0x${string}`],
        }),
      balance: (from) =>
        pub.readContract({
          address,
          abi,
          functionName: 'balanceOf',
          args: [from as `0x${string}`],
        }),
      ethBalance: () => pub.getBalance({ address: account.address }),
      nonceClear: async () => {
        const [pending, latest] = await Promise.all([
          pub.getTransactionCount({ address: account.address, blockTag: 'pending' }),
          pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        ]);
        return pending === latest;
      },
      simulate: async (a, signature, timestamp) => {
        try {
          await pub.call({
            account: a.from as `0x${string}`,
            to: address,
            data: authorizationCall(a, signature) as `0x${string}`,
            blockOverrides: { time: BigInt(timestamp) },
          });
          return true;
        } catch (e) {
          if (
            e instanceof ExecutionRevertedError ||
            (e instanceof Error &&
              'walk' in e &&
              typeof e.walk === 'function' &&
              e.walk((cause: unknown) => cause instanceof ExecutionRevertedError) instanceof
                ExecutionRevertedError)
          )
            return false;
          emit(options.alert, { type: 'base_rpc_unhealthy' });
          throw e;
        }
      },
      sign: async (to, data) => {
        const r = await wallet.prepareTransactionRequest({
          to: to as `0x${string}`,
          data: data as `0x${string}`,
          gas: options.gasLimit ?? 120_000n,
        });
        if (r.maxFeePerGas === undefined || r.maxFeePerGas > parseGwei(String(maxFeeGwei)))
          return null;
        const l1Fee = await estimateL1Fee(pub, {
          account,
          to: to as `0x${string}`,
          data: data as `0x${string}`,
        });
        const serialized = await wallet.signTransaction(r);
        return {
          serialized,
          hash: keccak256(serialized),
          maxCostWei: (options.gasLimit ?? 120_000n) * r.maxFeePerGas + 2n * l1Fee,
        };
      },
      send: (signed) =>
        wallet.sendRawTransaction({ serializedTransaction: signed as `0x${string}` }),
      transaction: async (hash) => {
        try {
          await pub.getTransaction({ hash: hash as `0x${string}` });
          return true;
        } catch (error) {
          const { TransactionNotFoundError } = await import('viem');
          if (error instanceof TransactionNotFoundError) return false;
          throw error;
        }
      },
      receipt: async (hash) => {
        let r: Awaited<ReturnType<typeof pub.getTransactionReceipt>>;
        try {
          r = await pub.getTransactionReceipt({ hash: hash as `0x${string}` });
        } catch (e) {
          const { TransactionReceiptNotFoundError } = await import('viem');
          if (e instanceof TransactionReceiptNotFoundError) return null;
          throw e;
        }
        if (!r) return null;
        if (r.l1Fee === null || r.l1Fee === undefined) throw new Error('receipt L1 fee is missing');
        return {
          reverted: r.status === 'reverted',
          costWei: r.gasUsed * r.effectiveGasPrice + r.l1Fee,
        };
      },
    },
    sendsPerMinute,
    Date.now,
    options,
  );
  const monitor = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      emit(options.alert, { type: 'base_rpc_unhealthy' });
      throw error;
    }
  };
  let enabled = false;
  const selfCheck = async () => {
    enabled = false;
    try {
      if ((await pub.getChainId()) !== 8453) throw new PayError('network_mismatch');
      const timestamp = Number((await pub.getBlock()).timestamp);
      await pub.call({
        to: account.address,
        data: '0x',
        blockOverrides: { time: BigInt(timestamp + (options.simulationMarginSeconds ?? 30)) },
      });
      enabled = true;
    } catch {
      emit(options.alert, { type: 'base_rpc_unhealthy' });
    }
    return enabled;
  };
  const guarded: Facilitator = (body, o) =>
    enabled
      ? monitor(() => facilitator(body, o))
      : Promise.resolve({ success: false, errorReason: 'unavailable', submissionAttempted: false });
  return Object.assign(guarded, { selfCheck, sample: () => monitor(() => facilitator.sample()) });
}
