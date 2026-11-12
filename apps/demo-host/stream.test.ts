import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { sendBody } from './stream.ts';

it.each(['during_prepare', 'before_finish'])(
  'does not bill a response closed %s',
  async (phase) => {
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      write(_chunk: Uint8Array, callback: () => void) {
        callback();
        return true;
      },
      end(this: EventEmitter & { destroyed: boolean }) {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('close');
      },
      destroy(this: EventEmitter & { destroyed: boolean }) {
        this.destroyed = true;
        this.emit('close');
      },
    });
    const delivery = {
      wrote: vi.fn(async () => {}),
      prepare: vi.fn(async () => {
        if (phase === 'during_prepare') {
          response.destroyed = true;
          response.emit('close');
        }
      }),
      finish: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
    };
    const pending = sendBody(
      {
        status: 200,
        headers: {},
        body: new Response(new Uint8Array(10)).body as ReadableStream<Uint8Array>,
        delivery,
      },
      response as unknown as ServerResponse,
    );
    await vi.waitFor(() => expect(delivery.interrupt).toHaveBeenCalledOnce());
    await pending;
    expect(delivery.wrote).toHaveBeenCalledWith(10);
    expect(delivery.prepare).toHaveBeenCalledOnce();
    expect(delivery.finish).not.toHaveBeenCalled();
  },
);
