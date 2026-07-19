import { describe, expect, it } from 'vitest';

import { deriveConnectionOwnerDigest } from './coordinator';

const KEY = 'a-secret-with-at-least-thirty-two-bytes';

describe('connection coordinator addressing', () => {
  it('is deterministic within one tenant and connection only', async () => {
    const first = await deriveConnectionOwnerDigest(KEY, 'tenant-a', 'connection-a');
    const repeated = await deriveConnectionOwnerDigest(KEY, 'tenant-a', 'connection-a');
    const anotherTenant = await deriveConnectionOwnerDigest(KEY, 'tenant-b', 'connection-a');

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(anotherTenant).not.toBe(first);
  });

  it('fails closed without sufficient namespace key material', async () => {
    await expect(
      deriveConnectionOwnerDigest(undefined, 'tenant-a', 'connection-a'),
    ).rejects.toThrow('Connection coordinator is not configured');
    await expect(
      deriveConnectionOwnerDigest('short', 'tenant-a', 'connection-a'),
    ).rejects.toThrow('Connection coordinator is not configured');
  });
});
