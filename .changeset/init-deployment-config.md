---
"@defdone/annon": patch
---

`annon init --deployment defdone` writes the configuration for the deployment run by defdone (contract, network, NEAR RPC, relayer, price cap and the demo shop with its approved profile) when no configuration file exists, then sets up the backup secret as before. In a terminal, plain `annon init` asks once whether to use that deployment; without a terminal and without the flag it writes no configuration and says how to add one. An existing configuration file is never changed, and a symlink or other non-regular file at the path is refused. The file is written owner-only and atomically. The init result adds a `config` field with the path and whether it was created, kept or not written. `--deployment` accepts only `defdone`. `init --agent` and agent mode are unchanged. The quickstart now starts with this command.
