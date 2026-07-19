import { describe, expect, it } from 'vitest';

import { hasRecentAuthentication } from './reauthentication';

describe('hasRecentAuthentication', () => {
  const now = Date.parse('2026-07-19T07:10:00.000Z');

  it('accepts a recent verified identity timestamp', () => {
    expect(hasRecentAuthentication('2026-07-19T07:06:00.000Z', 300, now)).toBe(true);
  });

  it('rejects missing, malformed, old or implausibly future timestamps', () => {
    expect(hasRecentAuthentication(undefined, 300, now)).toBe(false);
    expect(hasRecentAuthentication('not-a-date', 300, now)).toBe(false);
    expect(hasRecentAuthentication('2026-07-19T07:04:59.000Z', 300, now)).toBe(false);
    expect(hasRecentAuthentication('2026-07-19T07:12:00.000Z', 300, now)).toBe(false);
  });
});
