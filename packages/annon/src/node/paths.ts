import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';

/** Canonical paths are passed to I/O; tool-relative paths start at the operator directory. */
export async function confinePaths(input: Input, workDir: string): Promise<Input> {
  if (!['sell', 'open', 'verify'].includes(input.command)) return input;
  if (input.command === 'verify' && /^https?:/.test(input.target ?? '')) return input;
  try {
    const root = await realpath(workDir);
    const inside = (path: string) => {
      const tail = relative(root, path);
      if (
        tail === '..' ||
        tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(tail)
      )
        throw new Error();
      return path;
    };
    const confined = async (value: string, output = false) => {
      if (!value || value.includes('\0') || value.split(/[\\/]/).includes('..')) throw new Error();
      const path = resolve(root, value);
      try {
        return inside(await realpath(path));
      } catch (error) {
        if (!output || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A dangling symlink is an existing entry, never a new output path.
        const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (entry) throw new Error();
        return inside(resolve(await realpath(dirname(path)), basename(path)));
      }
    };
    const next = { ...input };
    if (input.command === 'sell') {
      if (!input.target) throw new Error();
      next.target = await confined(input.target);
      next.output = await confined(input.output ?? `${input.target}.pay2`, true);
    } else if (input.command === 'open') {
      const isId = (value: string) => /^0x[0-9a-f]{64}$/.test(value);
      if (input.target !== undefined && !isId(input.target))
        next.target = await confined(input.target);
      if (input.purchase !== undefined && !isId(input.purchase))
        next.purchase = await confined(input.purchase);
      if (input.output !== undefined) next.output = await confined(input.output, true);
      if (input.file !== undefined) next.file = await confined(input.file);
    } else if (input.target !== undefined) next.target = await confined(input.target);
    return next;
  } catch {
    throw new AdapterError(
      'path_not_allowed',
      'File paths must stay inside the configured workDir without parent traversal or symlink escape.',
      2,
    );
  }
}
