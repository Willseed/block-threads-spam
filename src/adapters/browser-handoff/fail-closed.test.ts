import { describe, expect, it } from 'vitest';

import { FailClosedBrowserHandoffProvider } from './fail-closed';

describe('FailClosedBrowserHandoffProvider', () => {
  it('never emits a browser capability', async () => {
    const provider = new FailClosedBrowserHandoffProvider();
    expect(provider.isAvailable()).toBe(false);
    await expect(
      provider.prepare({
        handoffId: 'handoff',
        approvedUsername: 'target',
        approvedPlatformId: 'platform-id',
        absoluteDeadlineAt: '2026-07-19T12:10:00.000Z',
      }),
    ).rejects.toThrow('Browser handoff capability is unavailable');
  });
});
