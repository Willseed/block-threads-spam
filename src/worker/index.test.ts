import { describe, expect, it } from 'vitest';

import { app } from './index';

describe('health endpoint', () => {
  it('reports that the service is available', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: 'threads-variant-guard',
      status: 'ok',
    });
  });
});
