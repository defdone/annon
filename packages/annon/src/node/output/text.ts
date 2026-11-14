/** Shared pieces of the human output: safe text, short IDs, aligned tables and field lists. */

/**
 * Text from a shop, a catalog or a host is untrusted. Control characters (terminal escapes) and
 * bidirectional overrides are replaced before it reaches a terminal; `lines` keeps newlines.
 */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
export function cleanText(value: unknown, lines = false): string {
  const text = String(value).replace(BIDI, '');
  return lines
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
      text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    : // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
      text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** `0x1234abcd...ef01` for a long ID or address; short values are returned whole. */
export const short = (id: string) => (id.length > 20 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id);

export const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** Left-aligned columns, two spaces apart; the last column is not padded. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Every field of a result as `name: value`, so a command without its own layout hides nothing. */
export function fields(result: Record<string, unknown>): string {
  return Object.entries(result)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key}: ${cleanText(value !== null && typeof value === 'object' ? JSON.stringify(value) : value)}`,
    )
    .join('\n');
}

export const networkName = (network: string) =>
  network === 'near:mainnet'
    ? 'NEAR mainnet'
    : network === 'near:testnet'
      ? 'NEAR testnet'
      : network;
