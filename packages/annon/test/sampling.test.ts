import { afterEach, expect, it, vi } from 'vitest';
import { bitCases, sampleCases } from './sampling.js';

afterEach(() => vi.unstubAllEnvs());

it('samples a fixed stride and both sides of every boundary, including the endpoints', () => {
  vi.stubEnv('ANNON_EXHAUSTIVE', '0');
  expect(sampleCases(600, [32, 64])).toEqual([0, 1, 31, 32, 33, 63, 64, 65, 257, 514, 599]);
  expect(sampleCases(600, [32, 64])).toEqual(sampleCases(600, [32, 64]));
  expect(sampleCases(0)).toEqual([]);
});

it('includes all bits on both sides of each byte boundary and keeps interior bits for exhaustive runs', () => {
  vi.stubEnv('ANNON_EXHAUSTIVE', '');
  const bits = bitCases(100, [0, 4, 12, 32, 100]);
  for (const bit of [
    ...Array.from({ length: 8 }, (_, i) => i),
    24,
    31,
    32,
    39,
    88,
    95,
    96,
    103,
    248,
    255,
    256,
    263,
    799,
  ])
    expect(bits).toContain(bit);
  expect(bits).not.toContain(150);
  vi.stubEnv('ANNON_EXHAUSTIVE', 'true');
  expect(bitCases(100, [0, 4, 12, 32, 100])).toEqual(bits);
});

it('exhaustive mode visits every original index exactly once in order', () => {
  vi.stubEnv('ANNON_EXHAUSTIVE', '1');
  expect(sampleCases(600, [32, 64])).toEqual(Array.from({ length: 600 }, (_, i) => i));
  expect(bitCases(100, [0, 4, 12, 32, 100])).toEqual(Array.from({ length: 800 }, (_, i) => i));
});
