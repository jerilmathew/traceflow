import { isIP, isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** An IPv6 customer usually controls a whole /64, so limit the prefix rather than one address. */
function ipv6Prefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

const normalize = (ip: string) => (isIPv6(ip) ? ipv6Prefix(ip) : ip);

/**
 * Identify a client for rate limiting. `header` names the single-address
 * header set by the hosting provider's edge (Railway: x-real-ip, Fly.io:
 * fly-client-ip). Only set it when the provider overwrites that header and the
 * app is reachable only through its edge. Anything that is not exactly one IP
 * (missing, duplicated or junk) falls back to the socket peer, so a malformed
 * header can only ever share a quota, never gain a fresh one.
 */
export function clientIdentifier(header = ''): (request: FastifyRequest) => string {
  const name = header.trim().toLowerCase();
  return (request) => {
    if (name) {
      const value = request.headers[name];
      if (typeof value === 'string' && isIP(value.trim())) return normalize(value.trim());
    }
    return normalize(request.ip);
  };
}
