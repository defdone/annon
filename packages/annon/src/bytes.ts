/** Byte operations shared without changing view, iterator or allocation semantics. */
export function concatParts(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function hexDigits(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function prefixedHex(b: Uint8Array): string {
  return `0x${hexDigits(b)}`;
}
