import { parseHeader } from '../src/envelope/pay2.js';

/** Boundaries in an unmodified valid file, before a bit flip or truncation. */
export function pay2Boundaries(file: Uint8Array<ArrayBuffer>, preview = false): number[] {
  const h = parseHeader(file, preview);
  // Fixed header fields, each commitment, and each chunk hash.
  const boundaries = [0, 4, 5, 6, 7, 8, 12, 44, 46, 50, 54];
  for (let at = 54; at <= h.prefixLen; at += 32) boundaries.push(at);
  if (preview) return boundaries;

  let at = h.prefixLen;
  for (const stanza of h.stanzas) {
    const typeEnd = at + 1 + stanza.type.length;
    const body = typeEnd + 2;
    boundaries.push(at, at + 1, typeEnd, body);
    if (stanza.type === 'near-ckd/v1') {
      boundaries.push(body + 1, body + 1 + (stanza.body[0] ?? 0));
    }
    at = body + stanza.body.length;
    boundaries.push(at);
  }
  // MAC, then the signature's r, s and recovery byte (or v2 auth padding).
  boundaries.push(
    h.headerLen - 97,
    h.headerLen - 65,
    h.headerLen - 33,
    h.headerLen - 1,
    h.headerLen,
  );
  at = h.headerLen;
  for (let i = 0; i < h.n; i++) {
    const end =
      i === h.n - 1
        ? file.length
        : at +
          (i === 0 ? h.metaLen : i === 1 && h.previewLen ? h.previewLen : 2 ** h.chunkLog2) +
          16;
    boundaries.push(at, end - 16, end);
    at = end;
  }
  return boundaries;
}
