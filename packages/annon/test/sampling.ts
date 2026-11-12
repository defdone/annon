/** Keep exhaustive iteration order; default to a fixed stride and boundary neighbours.
 * Bit samples include all 16 bits spanning each byte boundary. */
export function sampleCases(length: number, boundaries: number[] = []): number[] {
  if (process.env.ANNON_EXHAUSTIVE === '1') {
    return Array.from({ length }, (_, i) => i);
  }
  const cases = new Set<number>([0, length - 1]);
  for (let i = 0; i < length; i += 257) cases.add(i);
  for (const boundary of [0, ...boundaries, length]) {
    for (const delta of [-1, 0, 1]) cases.add(boundary + delta);
  }
  return [...cases].filter((i) => i >= 0 && i < length).sort((a, b) => a - b);
}

export const bitCases = (byteLength: number, byteBoundaries: number[] = []) =>
  sampleCases(
    byteLength * 8,
    byteBoundaries.flatMap((byte) => Array.from({ length: 16 }, (_, i) => byte * 8 - 8 + i)),
  );
