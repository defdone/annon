import { createAdapter } from '@defdone/annon/node/adapter';
import type { Input } from '@defdone/annon/node/cli';
import { publicError } from '@defdone/annon/node/errors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

// Secret values have no tool argument. Only explicitly selected files or server env supply keys.
// Deployment, trust, wallets, storage and spend limits belong to the server operator.
const common = {};
const target = z.string().min(1);
const urlRule = 'HTTPS URL (HTTP only for localhost, 127.0.0.1 or [::1])';
const price = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/)
  .describe('USDC decimal amount, up to six decimal places.');
export const schemas = {
  sell: z
    .strictObject({
      ...common,
      target: target.describe('Local plaintext file'),
      resume: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .optional(),
      price: price.optional(),
      split: target.describe('Comma-separated kind:id:bps recipients, totaling 10000').optional(),
      base: z.boolean().optional(),
      moderator: z.string().optional(),
      output: z.string().optional(),
    })
    .refine(
      (value) =>
        value.resume
          ? !value.price && !value.split && !value.base && !value.moderator
          : !!value.price && !!value.split,
      { message: 'Provide price/split for a new listing, or resume without new terms.' },
    ),
  buy: z.strictObject({
    ...common,
    target: target.describe(`${urlRule} for a file, or path to decoded x402 offer JSON`),
    url: z.string().optional().describe('Expected resource URL, required for an offer file'),
    route: z.enum(['near', 'base', '1click']).optional(),
    origin: z.string().optional().describe('Name of a human-configured allowed origin'),
    recovery: z.string().optional(),
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
    target: target.describe(`Local PAY2 file or ${urlRule} (header-only verification)`),
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
    'Resume a saved paid Base purchase with unlock and read final acceptance from the trusted contract. 1Click SUCCESS alone does not establish acceptance.',
};
const outputSchema = z.object({
  ok: z.boolean(),
  result: z
    .object({
      payment: z
        .object({
          amountUsdc: z.string(),
          amountBaseUnits: z.string(),
          asset: z.object({ symbol: z.literal('USDC'), id: z.string() }),
          network: z.string(),
          route: z.enum(['near', 'base', '1click']),
          source: z
            .object({
              chain: z.string(),
              asset: z.string(),
              amount: z.string(),
              depositBefore: z.string(),
              symbol: z.string().optional(),
              decimals: z.number().optional(),
              contractAddress: z.string().optional(),
              amountFormatted: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      retryAfterSeconds: z.number().optional(),
    })
    .catchall(z.unknown())
    .optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      fileId: z.string().optional(),
      minimumAmountUsdc: z.string().optional(),
      retryAfterSeconds: z.number().optional(),
    })
    .optional(),
});
export function createServer(
  execute: (input: Input) => Promise<Record<string, unknown>> = createAdapter(process.env, {
    agent: true,
  }),
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
          readOnlyHint: command === 'verify',
          destructiveHint: false,
          idempotentHint: command === 'verify',
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
