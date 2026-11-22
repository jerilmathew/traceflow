/**
 * GET /api/stream — Server-Sent Events.
 *
 * Events:
 *   event: ready   data: {}                       (sent on connect)
 *   event: traces  data: { traces: TraceSummary[] }
 *   event: resync  data: {}                       (client should refetch)
 *   : ping                                        (comment heartbeat every 15s)
 *
 * The browser's EventSource reconnects automatically (we suggest 3s via
 * `retry:`). Each connection unsubscribes on close; slow consumers whose
 * socket buffer grows past 1 MiB are disconnected rather than buffered
 * indefinitely, so a stuck tab cannot leak server memory.
 */
import type { FastifyInstance } from 'fastify';
import type { LiveEvent, LiveHub } from '../live';

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CLIENTS = 100;

export function registerStream(app: FastifyInstance, live: LiveHub): void {
  let clients = 0;

  app.get('/api/stream', (request, reply) => {
    if (clients >= MAX_CLIENTS) {
      void reply
        .status(503)
        .send({ error: { code: 'too_many_streams', message: 'too many live connections' } });
      return;
    }
    clients++;

    // Take over the raw socket: Fastify must not try to serialize a reply.
    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    // Hijacked replies bypass @fastify/cors, so mirror its decision manually.
    const allowOrigin = reply.getHeader('access-control-allow-origin');
    if (typeof allowOrigin === 'string') {
      headers['access-control-allow-origin'] = allowOrigin;
      headers.vary = 'Origin';
    }
    res.writeHead(200, headers);

    let seq = 0;
    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        request.log.warn('closing slow SSE consumer');
        cleanup();
        res.destroy();
      }
    };
    const send = (event: string, data: unknown) =>
      write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    write('retry: 3000\n\n');
    send('ready', {});

    const unsubscribe = live.subscribe((event: LiveEvent) => {
      if (event.type === 'traces') send('traces', { traces: event.traces });
      else send('resync', {});
    });
    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

    function cleanup() {
      if (closed) return;
      closed = true;
      clients--;
      clearInterval(heartbeat);
      unsubscribe();
    }
    request.raw.on('close', cleanup);
    res.on('error', cleanup);
  });
}
