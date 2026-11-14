/** Tab completion for the session: command names first, then that command's flags. */
import type { Command } from '../cli.js';
import { commandFlags, commandNames } from '../cli-flags.js';

export const sessionWords = ['help', 'exit', 'quit'];

export function complete(line: string): [string[], string] {
  const words = line.trimStart().split(/\s+/);
  const last = words.at(-1) ?? '';
  const [first = ''] = words[0] === 'annon' ? words.slice(1) : words;
  const typingCommand = words.length === (words[0] === 'annon' ? 2 : 1);
  const choices = typingCommand
    ? [...commandNames, ...sessionWords]
    : first === 'shop' && words.at(-2) === 'shop'
      ? ['add']
      : last.startsWith('-') && commandNames.includes(first as Command)
        ? commandFlags(first as Command)
        : [];
  const hits = choices.filter((choice) => choice.startsWith(last)).sort();
  return [hits.map((hit) => `${hit} `), last];
}
