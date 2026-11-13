import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasContentType } from '../../packages/annon/src/download/http.ts';
import { decodeUploadAuthorization } from '../../packages/annon/src/download/upload.ts';
import { CapacityError } from './capacity.ts';
import { UploadFault, type uploadService } from './uploads.ts';

export async function readUploadControl(
  req: IncomingMessage,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const declared = req.headers['content-length'];
  if (declared && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > max))
    throw new UploadFault('too_large', 413);
  for await (const piece of req) {
    size += piece.length;
    if (size > max) throw new UploadFault('too_large', 413);
    parts.push(piece);
  }
  const value = new Uint8Array(size);
  let at = 0;
  for (const piece of parts) {
    value.set(piece, at);
    at += piece.length;
  }
  return value;
}
export async function uploadHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ip: string,
  service: Awaited<ReturnType<typeof uploadService>> | undefined,
  limits: {
    maxJsonBytes?: number;
    maxHeaderBytes?: number;
    authHeaderBytes?: number;
    idleSeconds?: number;
    requestSeconds?: number;
  } = {},
): Promise<boolean> {
  if (
    path !== '/v1/uploads' &&
    !path.startsWith('/v1/uploads/') &&
    !path.startsWith('/v1/upload-reservations/')
  )
    return false;
  const send = (status: number, value: unknown) =>
    res
      .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(value));
  if (!service) {
    send(503, { error: 'unavailable', message: 'Encrypted hosting is unavailable.' });
    return true;
  }
  const match = /^\/v1\/(uploads|upload-reservations)\/([a-f0-9]{64})(?:\/(body|header))?$/.exec(
    path,
  );
  const binary = match?.[3] === 'body' || match?.[3] === 'header';
  const streaming = binary && req.method === 'PUT';
  const timer = streaming
    ? setTimeout(() => req.destroy(), (limits.requestSeconds ?? 1800) * 1000)
    : undefined;
  if (streaming) req.setTimeout((limits.idleSeconds ?? 600) * 1000, () => req.destroy());
  try {
    if (
      (req.method === 'POST' || req.method === 'PUT') &&
      !hasContentType(
        req.headers['content-type'] ?? null,
        binary ? 'application/octet-stream' : 'application/json',
      )
    ) {
      send(415, { error: 'bad_request', message: 'Unsupported content type.' });
      return true;
    }
    let result: { status: number; body: unknown };
    if (path === '/v1/uploads' && req.method === 'POST') {
      const raw = await readUploadControl(req, limits.maxJsonBytes ?? 131072);
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch {
        throw new UploadFault('bad_request');
      }
      result = await service.create(input, ip);
    } else if (match?.[1] === 'upload-reservations' && !match[3] && req.method === 'GET')
      result = { status: 200, body: await service.reservation(match[2] as string) };
    else if (match?.[1] === 'uploads') {
      let auth: ReturnType<typeof decodeUploadAuthorization>;
      try {
        const value = req.headers['annon-upload-authorization'];
        if (typeof value !== 'string') throw new Error();
        auth = decodeUploadAuthorization(value, limits.authHeaderBytes ?? 8192);
      } catch {
        throw new UploadFault('bad_signature', 403);
      }
      const id = match[2] as string;
      if (!match[3] && req.method === 'GET') result = await service.status(id, auth);
      else if (match[3] === 'body' && req.method === 'PUT')
        result = await service.body(id, auth, req, req.headers['content-length']);
      else if (match[3] === 'header' && req.method === 'PUT')
        result = await service.header(
          id,
          auth,
          await readUploadControl(req, limits.maxHeaderBytes ?? 65536),
        );
      else {
        send(405, { error: 'bad_request', message: 'Method is not allowed.' });
        return true;
      }
    } else {
      send(404, { error: 'not_found', message: 'Upload endpoint was not found.' });
      return true;
    }
    send(result.status, result.body);
  } catch (error) {
    const code =
      error instanceof UploadFault || error instanceof CapacityError
        ? error.code
        : 'operation_failed';
    const status =
      error instanceof UploadFault
        ? error.status
        : code === 'too_large'
          ? 413
          : code === 'host_capacity'
            ? 503
            : code === 'upload_conflict'
              ? 409
              : error instanceof CapacityError
                ? 400
                : 503;
    send(status, { error: code, message: 'Encrypted hosting could not be completed.' });
  } finally {
    clearTimeout(timer);
    if (streaming) req.setTimeout(120000);
  }
  return true;
}
