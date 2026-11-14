/** The session's opening lines. Read-only: no prompt, no network, no secret, nothing written. */
import { join } from 'node:path';
import { fileStore } from '../../pay/store-node.js';
import { agentPolicy } from '../agent.js';
import type { Input } from '../cli.js';
import { loadConfig, trustId } from '../config.js';
import { cleanText, networkName } from '../output/text.js';
import { version } from '../version.js';
import type { Environment } from '../wallets.js';

const probe = { command: 'shops' } as Input;

/**
 * A session needs a person at a terminal. Pipes, agent mode and a config that cannot say whether
 * it is an agent config all keep the one-shot behavior.
 */
export async function sessionAllowed(
  argv: string[],
  terminal: boolean,
  env: Environment,
): Promise<boolean> {
  if (!terminal || !(argv.length === 0 || (argv.length === 1 && argv[0] === 'shell'))) return false;
  try {
    return !(await agentPolicy(probe, env));
  } catch {
    return false;
  }
}

/** Human text only for a person at a terminal outside agent mode. */
export const humanOutput = async (terminal: boolean, env: Environment) =>
  terminal &&
  (await agentPolicy(probe, env).then(
    (agent) => !agent,
    () => false,
  ));

export async function welcome(env: Environment): Promise<string> {
  const lines = [`Annon ${version}`];
  try {
    const c = await loadConfig({ command: 'login' }, env, true);
    const trusted =
      c.trustContract === true ||
      (await fileStore(join(c.stateDir, 'trust')).load(trustId(c))) !== null;
    lines.push(
      `Network: ${networkName(c.network)}`,
      `Account: ${c.signer ? cleanText(c.signer.identity.id) : 'not signed in (run login)'}`,
      `Contract: ${c.contractId ? `${c.contractId} (${trusted ? 'trusted' : 'not trusted yet'})` : 'not configured'}`,
    );
  } catch {
    lines.push('Config: could not be read. Run a command to see why.');
  }
  lines.push('Type help for commands, exit to leave. Tab completes.');
  return lines.join('\n');
}
