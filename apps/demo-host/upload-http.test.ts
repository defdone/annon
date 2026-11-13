import { expect, it, vi } from 'vitest';
import {
  encodeUploadAuthorization,
  parseUpload,
} from '../../packages/annon/src/download/upload.ts';
import vectors from '../../specs/vectors/upload.json' with { type: 'json' };
import { uploadHttp } from './upload-http.ts';

it.each(['idle', 'request'] as const)(
  'enforces the upload %s deadline and clears timers on close',
  async (mode) => {
    vi.useFakeTimers();
    let rejectBody = (_error: Error) => {};
    const body = new Promise<never>((_resolve, reject) => {
      rejectBody = reject;
    });
    const request = parseUpload(vectors.cases[0]?.request);
    const req = {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'annon-upload-authorization': encodeUploadAuthorization(request),
      },
      setTimeout: vi.fn(),
      destroy: vi.fn(() => {
        rejectBody(new Error('Interrupted'));
      }),
    };
    const res = { writeHead: vi.fn(), end: vi.fn() };
    res.writeHead.mockReturnValue(res);
    const service = { body: vi.fn(() => body) };
    const pending = uploadHttp(
      req as never,
      res as never,
      `/v1/uploads/${'ab'.repeat(32)}/body`,
      'ip',
      service as never,
    );
    try {
      expect(service.body).toHaveBeenCalledOnce();
      expect(req.setTimeout).toHaveBeenCalledWith(600000, expect.any(Function));
      await vi.advanceTimersByTimeAsync(mode === 'idle' ? 599999 : 1799999);
      expect(req.destroy).not.toHaveBeenCalled();
      if (mode === 'idle') req.setTimeout.mock.calls[0]?.[1]();
      else await vi.advanceTimersByTimeAsync(1);
      expect(req.destroy).toHaveBeenCalledOnce();
      expect(await pending).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectBody(new Error('Finished'));
      await pending;
      vi.useRealTimers();
    }
  },
);

it('rejects an oversized declared control body before waiting for bytes', async () => {
  const { readUploadControl } = await import('./upload-http.ts');
  const req = { headers: { 'content-length': '131073' }, async *[Symbol.asyncIterator]() {} };
  await expect(readUploadControl(req as never, 131072)).rejects.toMatchObject({
    code: 'too_large',
  });
});

it('counts streamed control bytes when Content-Length is absent', async () => {
  const { readUploadControl } = await import('./upload-http.ts');
  const req = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(80);
      yield new Uint8Array(21);
    },
  };
  await expect(readUploadControl(req as never, 100)).rejects.toMatchObject({ code: 'too_large' });
});

it.each(['POST', 'status', 'reservation'] as const)(
  'keeps normal timers for control %s',
  async (route) => {
    const req = { method: route === 'POST' ? 'POST' : 'GET', headers: {}, setTimeout: vi.fn() };
    const res = { writeHead: vi.fn(), end: vi.fn() };
    res.writeHead.mockReturnValue(res);
    await uploadHttp(
      req as never,
      res as never,
      route === 'POST'
        ? '/v1/uploads'
        : `/v1/${route === 'status' ? 'uploads' : 'upload-reservations'}/${'ab'.repeat(32)}`,
      'ip',
      { reservation: async () => ({}) } as never,
    );
    expect(req.setTimeout).not.toHaveBeenCalled();
  },
);
