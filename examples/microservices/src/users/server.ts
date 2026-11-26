/**
 * User Service — owns customer accounts.
 *
 *   GET /users/:id   → profile + account status
 */
import { withSpan } from '@traceflow/telemetry';
import { HOST, USERS_PORT } from '../common/config';
import { HttpError, createServer } from '../common/http';

interface User {
  id: string;
  name: string;
  tier: 'standard' | 'plus';
  status: 'active' | 'suspended';
  region: string;
}

const USERS = new Map<string, User>(
  [
    { id: 'user-1001', name: 'Demo Customer 1', tier: 'plus', status: 'active', region: 'eu-west' },
    {
      id: 'user-1002',
      name: 'Demo Customer 2',
      tier: 'standard',
      status: 'active',
      region: 'us-east',
    },
    {
      id: 'user-1003',
      name: 'Demo Customer 3',
      tier: 'standard',
      status: 'active',
      region: 'eu-west',
    },
    {
      id: 'user-2001',
      name: 'Demo Customer 4',
      tier: 'plus',
      status: 'suspended',
      region: 'eu-central',
    },
  ].map((u) => [u.id, u as User]),
);

const app = createServer('users-service');

app.get<{ Params: { id: string } }>('/users/:id', async (request) => {
  const user = await withSpan(
    'user-directory.lookup',
    { 'user.id': request.params.id },
    async (span) => {
      const found = USERS.get(request.params.id);
      span.setAttribute('user.found', Boolean(found));
      return found;
    },
  );
  if (!user) throw new HttpError(404, `user ${request.params.id} not found`, 'user_not_found');

  // Derive purchase limits from the account tier (real computation, traced).
  const limits = await withSpan('account.entitlements', { 'user.tier': user.tier }, () => ({
    maxItemsPerOrder: user.tier === 'plus' ? 100 : 20,
    canCheckout: user.status === 'active',
  }));
  return { ...user, limits };
});

await app.listen({ host: HOST, port: USERS_PORT });
console.log(`users-service listening on http://${HOST}:${USERS_PORT}`);
