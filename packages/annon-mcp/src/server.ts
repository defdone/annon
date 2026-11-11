import { createAdapter } from '@defdone/annon/node/adapter';
import type { Input } from '@defdone/annon/node/cli';
import { publicError } from '@defdone/annon/node/errors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

// Secret values have no tool argument. Only explicitly selected files or server env supply keys.
const common = {
  config: z.string().optional(),
  contractId: z.string().optional(),
  nearRpc: z.string().optional(),
  baseRpc: z.string().optional(),
  network: z.string().optional(),
  stateDir: z.string().optional(),
  relayer: z.string().optional(),
  trustContract: z
    .boolean()
    .optional()
    .describe('Explicitly trust the configured contract for key release on first use.'),
  wallet: z.enum(['evm', 'solana', 'near']).optional(),
  evmKeyFile: z.string().optional(),
  solanaKeyFile: z.string().optional(),
  nearKeyFile: z.string().optional(),
  nearAccount: z.string().optional(),
  nearPublicKey: z.string().optional(),
  backupSecretFile: z.string().optional(),
};
const target = z.string().min(1);
const price = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/)
  .describe('USDC decimal amount, up to six decimal places.');
export const schemas = {
  sell: z.strictObject({
    ...common,
    target: target.describe('Local plaintext file'),
    price,
    split: target.describe('Comma-separated kind:id:bps recipients, totaling 10000'),
    base: z.boolean().optional(),
    moderator: z.string().optional(),
    output: z.string().optional(),
  }),
  buy: z.strictObject({
    ...common,
    target: target.describe('HTTPS file URL or path to decoded x402 offer JSON'),
    route: z.enum(['near', 'base', '1click']).optional(),
    fromChain: z.string().optional(),
    fromAsset: z.string().optional(),
    refundTo: z.string().optional(),
    recovery: z.string().optional(),
    maxPrice: price.optional(),
    moderator: z.string().optional().describe('A moderator the buyer explicitly trusts'),
  }),
  open: z.strictObject({
    ...common,
    target: target.describe('Purchase ID, encrypted backup, or PAY2 file with purchase argument'),
    purchase: z.string().optional(),
    file: z.string().optional(),
    url: z.string().optional(),
    output: target.describe('New output file; existing files are never overwritten'),
  }),
  verify: z.strictObject({
    ...common,
    target: target.describe('Local PAY2 file or HTTPS URL (header-only verification)'),
  }),
  recover: z.strictObject({
    ...common,
    recovery: target.describe('Controlled identity as evm:address, solana:key or near:account'),
    purchase: z.string().optional(),
  }),
  status: z.strictObject({ ...common, target: target.describe('Purchase ID') }),
};
const descriptions = {
  sell: 'Encrypt and register a local file with the SDK. Writes a PAY2 file; seller arranges hosting. May send registration and Base split transactions.',
  buy: 'Prepare and submit a purchase using the SDK. Returns deposit instructions for 1Click; fund them externally, then check annon_status. A submitted payment is not final acceptance.',
  open: 'Open a saved final purchase or recovery grant with the SDK. Downloads with a grant proof when necessary and writes plaintext to the named output file.',
  verify:
    'Check a PAY2 file against the trusted contract and seller authorization. A URL checks the public header; a local file checks the encrypted body too.',
  recover:
    'Recover purchases with a controlled wallet identity using SDK reopen. Fresh grant secrets are backed up before submission.',
  status:
    'Read final purchase acceptance from the trusted contract. 1Click SUCCESS alone does not establish acceptance.',
};
const outputSchema = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export function createServer(
  execute: (input: Input) => Promise<Record<string, unknown>> = createAdapter(),
) {
  const server = new McpServer({ name: 'annon', version: '0.0.0' });
  for (const command of ['sell', 'buy', 'open', 'verify', 'recover', 'status'] as const) {
    server.registerTool(
      `annon_${command}`,
      {
        description: descriptions[command],
        inputSchema: schemas[command],
        outputSchema,
        annotations: {
          readOnlyHint: command === 'verify' || command === 'status',
          destructiveHint: false,
          idempotentHint: command === 'verify' || command === 'status',
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await execute({ ...args, command, json: true } as Input);
          const structuredContent = { ok: true, result };
          return {
            structuredContent,
            content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          };
        } catch (error) {
          const { exitCode: _, ...safe } = publicError(error);
          const structuredContent = { ok: false, error: safe };
          return {
            isError: true,
            structuredContent,
            content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          };
        }
      },
    );
  }
  return server;
}
