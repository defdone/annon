import { expect, it } from 'vitest';
import { dockerImportProblems } from '../docker-test.ts';

it('includes every relative import reachable from server.ts and cutover.ts in the Docker context', async () => {
  expect(await dockerImportProblems(import.meta.dirname, ['server.ts', 'cutover.ts'])).toEqual([]);
});
