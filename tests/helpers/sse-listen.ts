import http from 'node:http';

export interface SseEvent {
  event: string;
  data: unknown;
  receivedAt: number;
}

export interface SseListener {
  events: SseEvent[];
  waitFor(predicate: (e: SseEvent) => boolean, timeoutMs: number): Promise<SseEvent>;
  close(): void;
}

export function listenToSse(url = 'http://127.0.0.1:9880/api/events'): Promise<SseListener> {
  return new Promise((resolveListener, rejectListener) => {
    const events: SseEvent[] = [];
    const waiters: Array<{ pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void; reject: (err: Error) => void }> = [];
    let buf = '';
    let closed = false;

    const failAllWaiters = (reason: string) => {
      closed = true;
      const err = new Error(reason);
      while (waiters.length > 0) {
        waiters.shift()!.reject(err);
      }
    };

    const req = http.get(url, (res) => {
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let evt = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          const ev: SseEvent = { event: evt, data: parsed, receivedAt: Date.now() };
          events.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i]!.pred(ev)) {
              waiters[i]!.resolve(ev);
              waiters.splice(i, 1);
            }
          }
        }
      });
      res.on('error', (err) => failAllWaiters(`SSE stream error: ${err.message}`));
      res.on('end', () => failAllWaiters('SSE stream ended'));

      const listener: SseListener = {
        events,
        waitFor(pred, timeoutMs) {
          if (closed) return Promise.reject(new Error('SSE listener closed'));
          const existing = events.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise<SseEvent>((resolve, reject) => {
            const entry = {
              pred,
              resolve: (ev: SseEvent) => { clearTimeout(timer); resolve(ev); },
              reject: (err: Error) => { clearTimeout(timer); reject(err); },
            };
            const timer = setTimeout(() => {
              const i = waiters.indexOf(entry);
              if (i >= 0) waiters.splice(i, 1);
              reject(new Error(`SSE waitFor timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            waiters.push(entry);
          });
        },
        close() {
          if (closed) return;
          closed = true;
          req.destroy();
          while (waiters.length > 0) {
            waiters.shift()!.reject(new Error('SSE listener closed'));
          }
        },
      };
      resolveListener(listener);
    });

    req.on('error', (err) => {
      if (closed) return;
      failAllWaiters(`SSE request error: ${err.message}`);
      rejectListener(err);
    });
  });
}
