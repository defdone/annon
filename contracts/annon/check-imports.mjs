// Fails if the wasm imports a host function outside this list. A new near-sdk can link host
// functions mainnet doesn't have yet, and the deploy then fails with "Link Error".
import { readFileSync } from 'node:fs';

const allowed = new Set([
  'attached_deposit',
  // BLS12-381 (NEP-488), for the buyer key check. Present on mainnet (protocol 88 has their costs),
  // but its config has bls12381_not_in_group_fix = false: behaviour on points outside G1 is being
  // verified before any mainnet deploy.
  'bls12381_p1_decompress',
  'bls12381_pairing_check',
  'block_timestamp',
  'current_account_id',
  'ecrecover',
  'ed25519_verify',
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
  'sha256',
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
