import { describe, expect, it } from 'vitest';

import { generateCandidateVariants } from './candidates';
import { InvalidUsernameError } from './usernames';

describe('generateCandidateVariants', () => {
  it('normalizes a username and explains bounded variants', () => {
    const variants = generateCandidateVariants('@Will.Seed', {
      totalLimit: 12,
      perRuleLimit: 3,
    });

    expect(variants).toHaveLength(12);
    expect(variants.map(({ username }) => username)).not.toContain('will.seed');
    expect(new Set(variants.map(({ username }) => username)).size).toBe(variants.length);
    expect(variants.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  it('uses only explicitly enabled rules', () => {
    const variants = generateCandidateVariants('loop', {
      enabledRules: ['visual-substitution'],
      perRuleLimit: 10,
    });

    expect(variants.map(({ username }) => username)).toEqual(['1oop', 'ioop', 'l0op', 'lo0p']);
    expect(variants.every(({ rules }) => rules.includes('visual-substitution'))).toBe(true);
  });

  it('enforces the total and per-rule limits deterministically', () => {
    const options = { totalLimit: 5, perRuleLimit: 2 } as const;
    const first = generateCandidateVariants('brandname', options);
    const second = generateCandidateVariants('brandname', options);

    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
    expect(first.filter(({ rules }) => rules.includes('punctuation'))).toHaveLength(2);
  });

  it('does not emit names beyond the platform length limit', () => {
    const variants = generateCandidateVariants('a'.repeat(30), {
      enabledRules: ['repetition', 'prefix', 'suffix', 'deletion'],
    });

    expect(variants.every(({ username }) => username.length <= 30)).toBe(true);
    expect(variants.every(({ rules }) => rules.includes('deletion'))).toBe(true);
  });

  it('rejects invalid usernames and unsafe limits', () => {
    expect(() => generateCandidateVariants('bad name')).toThrow(InvalidUsernameError);
    expect(() => generateCandidateVariants('valid', { totalLimit: 0 })).toThrow(RangeError);
    expect(() =>
      generateCandidateVariants('valid', { insertionCharacters: ['arbitrary-word'] }),
    ).toThrow(RangeError);
  });
});
