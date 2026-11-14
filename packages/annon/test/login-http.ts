/** A raw loopback HTTP call to the approval server, with exact headers. */
import { request } from 'node:http';

export const send = (url: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const r = request(
        new URL(path, url),
        { method: body === undefined ? 'GET' : 'POST', headers },
        (res) => {
          let text = '';
          res.on('data', (c) => {
            text += c;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
