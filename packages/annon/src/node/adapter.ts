/** Node I/O around the SDK. Settlement, commitments, encryption and proofs stay in the SDK. */
import { createCoreAdapter, type Dependencies } from './core-adapter.js';
// core-adapter.js loads first: it imports the SDK modules in the order this file did, so they initialize as before.

import { identityJson, parseIdentity } from '../settle-near/identity.js';
import { agentPolicy, configPath, initAgent, savePublicConfig } from './agent.js';
import { type BrowserSession, startBrowserSession } from './browser-login.js';
import type { Input } from './cli.js';
import { loadConfig } from './config.js';
import { AdapterError } from './errors.js';
import { osKeychain } from './keychain.js';
import { confinePaths } from './paths.js';
import { discoverShops, isDiscovery } from './shops.js';
import { assertSignerInput, configuredWallet } from './signer-wallet.js';
import { type SigningResult, signingRequest, verifySigningResult } from './signing.js';
import { type Environment, identity } from './wallets.js';

export { amount, nearAmount } from './amounts.js';
export type { Dependencies } from './core-adapter.js';

/** CLI session lifetime includes every wallet action and is always closed on exit. */
export function createAdapter(env: Environment = process.env, d: Dependencies = {}) {
  return async (o: Input): Promise<Record<string, unknown>> => {
    if (o.command !== 'init' && (o.signer || o.credentialEnv || o.credentialKeychain))
      throw new AdapterError(
        'signer_init_only',
        'Signer and credential references can only be set by init.',
        2,
      );
    const agent = await agentPolicy(o, env, d.agent);
    if (isDiscovery(o)) return discoverShops(o, env, agent, d.fetch);
    if (o.command === 'init') return initAgent(o, env, d.keychain ?? osKeychain);
    const c = await loadConfig(o, env, o.command === 'login', d.agent);
    if (agent || c.agent) o = await confinePaths(o, c.workDir as string);
    if (c.signer) {
      assertSignerInput(o);
      if (o.recovery && identityJson(identity(o.recovery)) !== identityJson(c.signer.identity))
        throw new AdapterError('wrong_identity', 'Recovery must match the configured signer.', 2);
    }
    if ((agent || c.agent) && o.command === 'login')
      throw new AdapterError('agent_policy', 'Agent mode refuses interactive login.', 2);
    let session: BrowserSession | undefined;
    let terms: unknown = null;
    const browser = async () => {
      if (!session) {
        session = await (d.browser ?? startBrowserSession)({ noOpen: o.noOpen === true });
        const port = new URL(session.url).port;
        d.notify?.(
          `Annon pairing code ${session.pairingCode}${o.noOpen ? `\n${session.url}` : ''}\nFor SSH: forward this port with ssh -L ${port}:127.0.0.1:${port} host. Use --no-open for a manual pairing URL.`,
        );
      }
      return session;
    };
    try {
      if (o.command === 'login') {
        const s = await browser();
        const kind = o.wallet ?? 'evm';
        if (kind === 'solana') throw new Error('browser Solana login is not supported');
        const challenge = `Annon login: ${crypto.randomUUID()} on ${c.network}`;
        const q = signingRequest(
          kind === 'evm' ? 'evm.personalSign' : 'near.nep413',
          kind === 'evm' ? 'eip155:8453' : c.network,
          '',
          kind === 'evm'
            ? { message: challenge }
            : {
                message: challenge,
                recipient: c.contractId || 'annon-cli',
                nonce: [...crypto.getRandomValues(new Uint8Array(32))],
                callbackUrl: new URL('/callback', s.url).href,
              },
        );
        let identity: ReturnType<typeof parseIdentity> | undefined;
        await s.request<SigningResult>(q, async (r) => {
          const selected = parseIdentity({ kind, id: kind === 'evm' ? r.account : r.accountId });
          await verifySigningResult({ ...q, account: selected.id }, r, c.nearRpc);
          identity = selected;
        });
        if (!identity) throw new Error('login failed');
        await savePublicConfig(configPath(o, env), {
          signer: { mode: 'browser', identity },
          agent: false,
          network: c.network,
          nearRpc: c.nearRpc,
          ...(c.contractId ? { contractId: c.contractId } : {}),
          ...(c.baseRpc ? { baseRpc: c.baseRpc } : {}),
        });
        return { identity, network: c.network, mode: 'browser' };
      }
      const signer = c.signer;
      return await createCoreAdapter(env, {
        ...d,
        agent: agent || c.agent === true,
        browserApprovals: signer?.mode === 'browser',
        paymentTerms: (value) => {
          terms = value;
          d.paymentTerms?.(value);
        },
        ...(signer && !d.wallet
          ? {
              wallet: (input, environment) =>
                configuredWallet(
                  signer,
                  c,
                  input as Input,
                  environment,
                  d.keychain ?? osKeychain,
                  browser,
                  () => terms,
                ),
            }
          : {}),
      })(o);
    } finally {
      await session?.close();
    }
  };
}
