import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1Repository, TenantAuthorizationError } from './repository';

function deterministicIds(...values: string[]) {
  const queue = [...values];
  return () => queue.shift() ?? crypto.randomUUID();
}

describe('D1Repository tenant isolation', () => {
  it('creates one stable personal tenant per verified identity', async () => {
    const repository = new D1Repository(env.DB, {
      idFactory: deterministicIds('user', 'tenant', 'audit'),
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });

    const first = await repository.ensurePersonalTenant({
      subject: 'idp|owner',
      email: 'owner@example.com',
    });
    const second = await repository.ensurePersonalTenant({ subject: 'idp|owner' });

    expect(first).toEqual({ tenantId: 'tnt_tenant', userId: 'usr_user' });
    expect(second).toEqual(first);
  });

  it('stores and reads connections only through tenant membership', async () => {
    const repository = new D1Repository(env.DB, {
      idFactory: deterministicIds(
        'owner-user',
        'owner-tenant',
        'owner-audit',
        'other-user',
        'other-tenant',
        'other-audit',
        'connection',
        'connection-audit',
      ),
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const owner = await repository.ensurePersonalTenant({ subject: 'idp|owner' });
    const other = await repository.ensurePersonalTenant({ subject: 'idp|other' });

    await repository.createConnection(owner, 'willseed', 'meta_oauth');

    await expect(repository.listConnections(owner)).resolves.toHaveLength(1);
    await expect(
      repository.listConnections({ tenantId: owner.tenantId, userId: other.userId }),
    ).resolves.toEqual([]);
  });

  it('rejects candidate writes through another tenant connection ID', async () => {
    const repository = new D1Repository(env.DB, {
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const owner = await repository.ensurePersonalTenant({ subject: 'idp|owner' });
    const attacker = await repository.ensurePersonalTenant({ subject: 'idp|attacker' });
    const connection = await repository.createConnection(owner, 'willseed', 'meta_oauth');

    await expect(
      repository.addCandidate(attacker, connection.id, {
        username: 'will.seed',
        sourceType: 'manual',
        sourceRules: [],
        reasons: ['使用者人工加入'],
      }),
    ).rejects.toBeInstanceOf(TenantAuthorizationError);
    await expect(repository.listCandidates(attacker, connection.id)).resolves.toEqual([]);
  });

  it('stores explainable candidates for the owning tenant', async () => {
    const repository = new D1Repository(env.DB, {
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const owner = await repository.ensurePersonalTenant({ subject: 'idp|owner' });
    const connection = await repository.createConnection(owner, 'willseed', 'meta_oauth');

    const candidate = await repository.addCandidate(owner, connection.id, {
      username: 'will.seed',
      sourceType: 'generated',
      sourceRules: ['punctuation'],
      reasons: ['在原名稱附近加入標點'],
      priority: 'medium',
    });

    expect(candidate.status).toBe('new');
    await expect(repository.listCandidates(owner, connection.id)).resolves.toEqual([candidate]);
  });
});
