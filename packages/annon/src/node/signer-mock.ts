/** Reference in-memory adapter for tests/provider integrations; inject signing and policy. */
import { json, type Operation, type SigningRequest, type SigningResult } from './signing.js';

const canonical = (x: unknown): string =>
  x && typeof x === 'object'
    ? Array.isArray(x)
      ? `[${x.map(canonical)}]`
      : `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
          .join(',')}}`
    : JSON.stringify(x);
export function signerMock(o: {
  credential: string;
  account: string;
  chain: string;
  operations: Operation[];
  approve: (q: SigningRequest) => Promise<SigningResult | 'pending' | 'rejected'>;
}) {
  const requests = new Map<
    string,
    {
      exact: string;
      q: SigningRequest;
      status: 'pending' | 'approved' | 'rejected';
      result?: SigningResult;
    }
  >();
  const handle = async (request: Request): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${o.credential}`)
      return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === '/v1/capabilities' && request.method === 'GET')
      return Response.json({
        version: 1,
        account: o.account,
        chain: o.chain,
        operations: o.operations,
      });
    let id: string;
    if (path === '/v1/requests' && request.method === 'POST') {
      const q = (await request.json()) as SigningRequest;
      if (
        q.version !== 1 ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(q.id) ||
        q.account !== o.account ||
        q.chain !== o.chain ||
        !o.operations.includes(q.operation) ||
        !Number.isSafeInteger(q.expiresAt) ||
        q.expiresAt <= Date.now()
      )
        return new Response(null, { status: 400 });
      id = q.id;
      const exact = canonical(q);
      const old = requests.get(id);
      if (old && old.exact !== exact) return new Response(null, { status: 409 });
      if (!old) {
        // Claim before awaiting provider approval, so duplicate requests cannot sign twice.
        requests.set(id, { exact, q, status: 'pending' });
        const result = await o.approve(JSON.parse(json(q)));
        const entry = requests.get(id);
        if (!entry) throw new Error('missing claimed request');
        if (result === 'pending' || result === 'rejected') entry.status = result;
        else {
          entry.status = 'approved';
          entry.result = result;
        }
      }
    } else if (request.method === 'GET' && path.startsWith('/v1/requests/'))
      id = path.slice('/v1/requests/'.length);
    else return new Response(null, { status: 404 });
    const entry = requests.get(id);
    if (!entry) return new Response(null, { status: 404 });
    if (entry.q.expiresAt <= Date.now()) return new Response(null, { status: 410 });
    return Response.json(
      { version: 1, id, status: entry.status, ...(entry.result ? { result: entry.result } : {}) },
      { headers: { 'cache-control': 'no-store' } },
    );
  };
  return Object.assign(handle, {
    decide(id: string, result: SigningResult | 'rejected') {
      const entry = requests.get(id);
      if (entry?.status !== 'pending' || entry.q.expiresAt <= Date.now())
        throw new Error('no pending approval');
      if (result === 'rejected') entry.status = 'rejected';
      else {
        entry.status = 'approved';
        entry.result = result;
      }
    },
  });
}
