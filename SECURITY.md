# Security

Annon handles payments and decryption keys, so we take reports seriously.

**Please don't open a public issue for a vulnerability.** Report it privately through GitHub:
the "Security" tab of this repository, then "Report a vulnerability". We answer within 72 hours.

In scope: the NEAR contract in `contracts/`, the SDK, CLI and MCP packages in `packages/`
(private for now), the relayer in `apps/relayer`, and the demo host in `apps/demo-host`.
A deployed contract is locked and can't be patched in place; a fix ships as a new contract
version, and the SDK moves to it.
