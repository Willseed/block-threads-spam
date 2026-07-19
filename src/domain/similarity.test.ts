import { describe, expect, it } from 'vitest';

import { assessProfileSimilarity } from './similarity';

describe('assessProfileSimilarity', () => {
  it('assigns high review priority when several explainable signals align', () => {
    const assessment = assessProfileSimilarity(
      {
        username: 'willseed',
        displayName: 'Will Seed Studio',
        bio: '產品設計與開發',
        externalUrl: 'https://willseed.example/about',
      },
      {
        username: 'willse3d',
        displayName: 'Will Seed Studio',
        bio: '產品設計與開發',
        externalUrl: 'https://willseed.example/contact',
        avatarSimilarity: 0.9,
      },
    );

    expect(assessment.priority).toBe('high');
    expect(assessment.score).toBeGreaterThanOrEqual(70);
    expect(assessment.signals.map(({ kind }) => kind)).toEqual([
      'username',
      'display-name',
      'avatar',
      'bio',
      'external-link',
    ]);
    expect(assessment.disclaimer).toContain('不代表');
  });

  it('treats a visual-confusable username as a reason to review, not a verdict', () => {
    const assessment = assessProfileSimilarity(
      { username: 'coolstudio' },
      { username: 'c00lstud1o' },
    );

    expect(assessment.priority).toBe('medium');
    expect(assessment.signals[0]?.explanation).toContain('視覺混淆');
  });

  it('keeps unrelated profiles at low priority', () => {
    const assessment = assessProfileSimilarity(
      { username: 'alpha.studio', displayName: 'Alpha Studio' },
      { username: 'different_person', displayName: 'Someone Else' },
    );

    expect(assessment.priority).toBe('low');
    expect(assessment.score).toBeLessThan(40);
  });

  it('rejects adapter-provided scores outside the allowed range', () => {
    expect(() =>
      assessProfileSimilarity(
        { username: 'valid_name' },
        { username: 'valid.name', avatarSimilarity: 1.2 },
      ),
    ).toThrow(RangeError);
  });
});
