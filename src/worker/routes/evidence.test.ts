import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1Repository } from '../../platform/d1/repository';
import { R2EvidenceRepository } from '../../platform/r2/evidence-repository';
import { createApp } from '../index';
import type { IdentityVerifier } from '../identity/types';

function applicationFor(subject: string, authenticatedAt?: string) {
  const verifier: IdentityVerifier = {
    verify: () =>
      Promise.resolve({
        subject,
        ...(authenticatedAt ? { authenticatedAt } : {}),
      }),
  };
  return createApp({ identityVerifier: verifier });
}

async function evidenceFixture() {
  const d1 = new D1Repository(env.DB);
  const owner = await d1.ensurePersonalTenant({ subject: 'idp|owner' });
  const connection = await d1.createConnection(owner, 'willseed', 'meta_oauth');
  const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE);
  const evidence = await repository.put(owner, {
    connectionId: connection.id,
    evidenceType: 'profile_snapshot',
    source: 'fixture',
    contentType: 'application/json',
    body: new TextEncoder().encode('{"username":"will.seed"}'),
    retentionUntil: new Date(Date.now() + 86_400_000),
  });
  return evidence;
}

describe('private evidence API', () => {
  it('proxies evidence with private security headers after recent authentication', async () => {
    const evidence = await evidenceFixture();
    const response = await applicationFor('idp|owner', new Date().toISOString()).request(
      `/api/evidence/${evidence.id}`,
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    await expect(response.text()).resolves.toBe('{"username":"will.seed"}');
  });

  it('requires recent authentication even for the owning tenant', async () => {
    const evidence = await evidenceFixture();
    const response = await applicationFor('idp|owner').request(
      `/api/evidence/${evidence.id}`,
      undefined,
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'reauthentication_required' },
    });
  });

  it('does not reveal an evidence ID across tenants', async () => {
    const evidence = await evidenceFixture();
    const response = await applicationFor('idp|other', new Date().toISOString()).request(
      `/api/evidence/${evidence.id}`,
      undefined,
      env,
    );

    expect(response.status).toBe(404);
  });

  it('deletes one authorized object without exposing its R2 key', async () => {
    const evidence = await evidenceFixture();
    const app = applicationFor('idp|owner', new Date().toISOString());
    const deleted = await app.request(
      `/api/evidence/${evidence.id}`,
      { method: 'DELETE' },
      env,
    );
    expect(deleted.status).toBe(204);

    const after = await app.request(`/api/evidence/${evidence.id}`, undefined, env);
    expect(after.status).toBe(404);
  });
});
