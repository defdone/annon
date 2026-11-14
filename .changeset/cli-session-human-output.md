---
'@defdone/annon': patch
---

The CLI is easier to use by hand. `annon` with no arguments in a terminal (or `annon shell`) starts
an interactive session that runs the usual commands without the prefix until `exit`. In a terminal
the commands print short text in place of JSON: a login line, a numbered catalog table, the buy
terms and next step, one or two lines for status and open. `--json`, piped output and agent mode
keep the JSON envelope unchanged.

`annon buy` takes a catalog row number (`buy 2 --shop demo`) and `--open <file>`, which waits for
acceptance and writes the file. `annon status` and `annon open` without an ID use the latest
purchase saved for the configured contract and network, and accept an ID prefix of 8 or more hex
digits for purchases saved for it. The `next` text of a NEAR or Base buy no
longer talks about a deposit.
