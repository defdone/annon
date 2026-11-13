/** Node-only entry: the adapter behind the annon CLI and the MCP server. */

export { type AnnonErrorCode, annonErrorCodes, type PublicError } from '../errors.js';
export { createAdapter } from './adapter.js';
export type { BudgetRecord } from './budget.js';
export { BudgetError } from './budget.js';
export type { Input } from './cli.js';
export { AdapterError, publicError } from './errors.js';
