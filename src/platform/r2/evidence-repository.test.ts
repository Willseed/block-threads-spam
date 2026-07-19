import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { D1Repository } from '../d1/repository';
import { InvalidEvidenceError, R2EvidenceRepository } from './evidence-repository';

async function fixture() {
  const d1 = new D1Repository(env.DB);
  const owner = await d1.ensurePersonalTenant({ subject: 'idp|owner' });
  const other = await d1.ensurePersonalTenant({ subject: 'idp|other' });
  const connection = await d1.createConnection(owner, 'willseed', 'meta_oauth');
  const candidate = await d1.addCandidate(owner, connection.id, {
    username: 'will.seed',
    sourceType: 'manual',
    sourceRules: [],
    reasons: ['人工加入'],
  });
  return { owner, other, connection, candidate };
}

describe('R2EvidenceRepository', () => {
  it('stores hashed private evidence and retrieves it for the owning tenant', async () => {
    const { owner, connection, candidate } = await fixture();
    const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE, {
      idFactory: (() => {
        const ids = ['record', 'object', 'audit'];
        return () => ids.shift() ?? crypto.randomUUID();
      })(),
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });

    const record = await repository.put(owner, {
      connectionId: connection.id,
      candidateId: candidate.id,
      evidenceType: 'profile_snapshot',
      source: 'fixture',
      contentType: 'application/json',
      body: new TextEncoder().encode('{"username":"will.seed"}'),
      retentionUntil: new Date('2026-08-19T07:00:00.000Z'),
    });

    expect(record.id).toBe('evd_record');
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    const evidence = await repository.get(owner, record.id);
    expect(evidence).toBeDefined();
    await expect(new Response(evidence?.body).text()).resolves.toBe('{"username":"will.seed"}');

    const stored = await env.EVIDENCE.get(
      `evidence/${owner.tenantId}/${connection.id}/object`,
    );
    expect(stored?.customMetadata).toEqual({ evidenceId: 'evd_record' });
  });

  it('does not reveal evidence to another tenant', async () => {
    const { owner, other, connection } = await fixture();
    const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE, {
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const record = await repository.put(owner, {
      connectionId: connection.id,
      evidenceType: 'diagnostic',
      source: 'fixture',
      contentType: 'text/plain',
      body: new TextEncoder().encode('safe diagnostic'),
      retentionUntil: new Date('2026-07-20T07:00:00.000Z'),
    });

    await expect(repository.get(other, record.id)).resolves.toBeUndefined();
    await expect(repository.delete(other, record.id)).resolves.toBe(false);
  });

  it('deletes the private object and leaves an authorization tombstone', async () => {
    const { owner, connection } = await fixture();
    const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE, {
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const record = await repository.put(owner, {
      connectionId: connection.id,
      evidenceType: 'diagnostic',
      source: 'fixture',
      contentType: 'text/plain',
      body: new TextEncoder().encode('temporary'),
      retentionUntil: new Date('2026-07-20T07:00:00.000Z'),
    });

    await expect(repository.delete(owner, record.id)).resolves.toBe(true);
    await expect(repository.get(owner, record.id)).resolves.toBeUndefined();
  });

  it('rejects empty, oversized or expired evidence before writing', async () => {
    const { owner, connection } = await fixture();
    const repository = new R2EvidenceRepository(env.DB, env.EVIDENCE, {
      now: () => new Date('2026-07-19T07:00:00.000Z'),
    });
    const base = {
      connectionId: connection.id,
      evidenceType: 'diagnostic' as const,
      source: 'fixture' as const,
      contentType: 'text/plain' as const,
      retentionUntil: new Date('2026-07-20T07:00:00.000Z'),
    };

    await expect(repository.put(owner, { ...base, body: new Uint8Array() })).rejects.toBeInstanceOf(
      InvalidEvidenceError,
    );
    await expect(
      repository.put(owner, { ...base, body: new Uint8Array(5 * 1024 * 1024 + 1) }),
    ).rejects.toBeInstanceOf(InvalidEvidenceError);
    await expect(
      repository.put(owner, {
        ...base,
        body: new TextEncoder().encode('expired'),
        retentionUntil: new Date('2026-07-18T07:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(InvalidEvidenceError);
  });
});
