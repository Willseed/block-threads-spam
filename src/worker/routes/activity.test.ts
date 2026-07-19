import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';

function applicationFor(subject: string) {
  const identityVerifier: IdentityVerifier = {
    verify: () => Promise.resolve({ subject }),
  };
  return createApp({ identityVerifier });
}

describe('activity API', () => {
  it('returns bounded allowlisted audit fields for the current tenant only', async () => {
    const owner = applicationFor('idp|activity-owner');
    const attacker = applicationFor('idp|activity-attacker');
    const created = await owner.request(
      '/api/connections',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protectedUsername: 'activity.owner' }),
      },
      env,
    );
    expect(created.status).toBe(201);

    const response = await owner.request('/api/activity?limit=10', undefined, env);
    expect(response.status).toBe(200);
    const body = await response.json<{
      events: { eventType: string; metadata?: unknown; createdAt: string }[];
    }>();
    expect(body.events.map(({ eventType }) => eventType)).toContain('connection.created');
    expect(body.events.every((event) => event.metadata === undefined)).toBe(true);

    const other = await attacker.request('/api/activity?limit=10', undefined, env);
    const otherBody = await other.json<{ events: { eventType: string }[] }>();
    expect(otherBody.events.map(({ eventType }) => eventType)).not.toContain('connection.created');
  });

  it('rejects unbounded activity queries', async () => {
    const response = await applicationFor('idp|activity-owner').request(
      '/api/activity?limit=1000',
      undefined,
      env,
    );
    expect(response.status).toBe(400);
  });
});
