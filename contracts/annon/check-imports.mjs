// Fails if the wasm imports a host function outside this list. A new near-sdk can link host
// functions mainnet doesn't have yet, and the deploy then fails with "Link Error".
import { readFileSync } from 'node:fs';

const allowed = new Set([
  'attached_deposit',
  'block_timestamp',
  'current_account_id',
  'ecrecover',
  'input',
  'keccak256',
  'log_utf8',
  'panic_utf8',
  'predecessor_account_id',
  'prepaid_gas',
  'promise_batch_action_function_call_weight',
  'promise_batch_action_transfer',
  'promise_batch_create',
  'promise_result',
  'promise_return',
  'promise_batch_then',
  'read_register',
  'register_len',
  'storage_has_key',
  'storage_read',
  'storage_remove',
  'storage_usage',
  'storage_write',
  'value_return',
]);

const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(process.argv[2])));
const unknown = imports.filter((i) => i.module !== 'env' || !allowed.has(i.name));
if (unknown.length) {
  console.error(
    'host functions not on the list:',
    unknown.map((i) => `${i.module}.${i.name}`),
  );
  process.exit(1);
}
console.log(`wasm imports ok (${imports.length})`);
