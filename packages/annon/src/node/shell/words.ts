/** Splits a session line into arguments: spaces separate, quotes and backslashes keep them. */
import { AdapterError } from '../errors.js';

export function splitWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) word += line.charAt(++i);
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (ch === '\\' && i + 1 < line.length) word = (word ?? '') + line.charAt(++i);
    else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? '') + ch;
  }
  if (quote) throw new AdapterError('invalid_arguments', 'A quote is not closed.', 2);
  if (word !== undefined) words.push(word);
  return words;
}
