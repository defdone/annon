// Every test file gets its own empty HOME, so no test reads the developer's ~/.config/annon
// (config, agent policy or backup secret) or ~/.local/share/annon.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'annon-home-'));
process.env.HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
