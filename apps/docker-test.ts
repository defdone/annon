import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export async function dockerAppFiles(app: string): Promise<string[]> {
  return (await readdir(app)).filter(
    (name) =>
      (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'vitest.config.ts') ||
      name === 'ts-hook.mjs',
  );
}

async function imageContext(app: string) {
  const root = resolve(app, '../..');
  const rules = (await readFile(join(root, '.dockerignore'), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const lines = (await readFile(join(app, 'Dockerfile'), 'utf8')).split(/\r?\n/);
  const finalStage = lines.reduce(
    (last, line, index) => (/^FROM\s/i.test(line) ? index : last),
    -1,
  );
  const copies = lines
    .slice(finalStage + 1)
    .filter((line) => line.startsWith('COPY '))
    .map((line) => {
      const args = line.split(/\s+/).slice(1, -1);
      return {
        sources: args.filter((arg) => !arg.startsWith('--')),
        exclusions: args
          .filter((arg) => arg.startsWith('--exclude='))
          .map((arg) => arg.slice('--exclude='.length)),
      };
    });
  const prefixes = (file: string) =>
    file.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const matches = (file: string, pattern: string) => {
    // The context and COPY patterns use these globs. Docker also matches leading dots.
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/|\*\*|\*|\?/g, (glob) => {
        if (glob === '**/') return '(?:.*/)?';
        if (glob === '**') return '.*';
        return glob === '*' ? '[^/]*' : '[^/]';
      });
    const regex = new RegExp(`^${expression}$`);
    return prefixes(file).some((part) => regex.test(part));
  };
  const included = (file: string) => {
    let allow = true;
    for (const rule of rules) {
      const negated = rule.startsWith('!');
      if (matches(file, negated ? rule.slice(1) : rule)) allow = negated;
    }
    return allow;
  };
  const files = new Set<string>();
  for (const { sources, exclusions } of copies) {
    for (const source of sources) {
      if (source.startsWith('/')) continue;
      const clean = source.replace(/\/$/, '');
      let directory = false;
      try {
        directory = (await stat(join(root, clean))).isDirectory();
      } catch {
        // Wildcard sources are expanded below, without directory exclusion semantics.
      }
      const base = directory ? clean : dirname(clean);
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
          const file = join(folder, entry.name);
          if (!included(file)) continue;
          if (directory && exclusions.some((pattern) => matches(relative(clean, file), pattern)))
            continue;
          if (entry.isDirectory()) await walk(file);
          else if (directory || matches(file, clean)) files.add(file);
        }
      };
      await walk(base);
    }
  }
  return { root, included, files };
}

/** Files copied from the build context into the final stage, after context and directory exclusions. */
export async function dockerImageFiles(app: string): Promise<string[]> {
  return [...(await imageContext(app)).files].sort();
}

/** Check the final image against the complete relative import graph. */
export async function dockerImportProblems(app: string, entries: string[]): Promise<string[]> {
  const { root, included, files } = await imageContext(app);
  const problems: string[] = [];
  const check = (file: string) => {
    if (!included(file)) problems.push(`${file}: excluded by .dockerignore`);
    if (!files.has(file)) problems.push(`${file}: absent from Dockerfile COPY`);
  };
  for (const name of (await readdir(app)).filter((name) => name.endsWith('.test.ts'))) {
    const file = relative(root, join(app, name));
    if (included(file)) problems.push(`${file}: test included by .dockerignore`);
  }
  for (const folder of ['', relative(root, app), 'packages/annon/src']) {
    for (const name of ['.env', '.env.local', '.env.ts']) {
      const file = join(folder, name);
      if (included(file)) problems.push(`${file}: environment file included by .dockerignore`);
    }
  }
  const visited = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    check(relative(root, file));
    const source = await readFile(file, 'utf8');
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue;
      let target = resolve(dirname(file), fileName);
      // Match the services' ts-hook fallback for SDK .js specifiers.
      if (target.endsWith('.js')) {
        try {
          await readFile(target);
        } catch {
          target = `${target.slice(0, -3)}.ts`;
        }
      }
      await visit(target);
    }
  }
  for (const entry of entries) await visit(join(app, entry));
  return problems.sort();
}
