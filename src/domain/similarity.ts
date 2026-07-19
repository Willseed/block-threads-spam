import { parseUsername } from './usernames';

export type ReviewPriority = 'low' | 'medium' | 'high';
export type SimilaritySignalKind =
  | 'username'
  | 'display-name'
  | 'avatar'
  | 'bio'
  | 'external-link';

export interface ProfileSignals {
  username: string;
  displayName?: string;
  bio?: string;
  externalUrl?: string;
  avatarSimilarity?: number;
}

export interface SimilaritySignal {
  kind: SimilaritySignalKind;
  score: number;
  contribution: number;
  explanation: string;
}

export interface SimilarityAssessment {
  score: number;
  priority: ReviewPriority;
  signals: SimilaritySignal[];
  disclaimer: string;
}

const DISCLAIMER = '相似度只用於安排人工審核順序，不代表帳號已被判定為冒用或詐騙。';

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Similarity values must be between 0 and 1');
  }
  return value;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-Hant').trim();
}

function confusableSkeleton(value: string): string {
  return value.replaceAll('0', 'o').replaceAll('1', 'l').replaceAll('i', 'l');
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex + 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + substitutionCost,
        ),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function editSimilarity(left: string, right: string): number {
  const maximumLength = Math.max(left.length, right.length);
  if (maximumLength === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maximumLength;
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function urlSimilarity(leftValue: string, rightValue: string): number {
  let left: URL;
  let right: URL;
  try {
    left = new URL(leftValue);
    right = new URL(rightValue);
  } catch {
    return 0;
  }

  if (left.hostname === right.hostname && left.pathname === right.pathname) return 1;
  if (left.hostname === right.hostname) return 0.8;
  return editSimilarity(left.hostname, right.hostname) >= 0.9 ? 0.5 : 0;
}

function contribution(score: number, weight: number): number {
  return Math.round(score * weight);
}

function usernameSignal(protectedUsername: string, candidateUsername: string): SimilaritySignal {
  const protectedSkeleton = confusableSkeleton(protectedUsername);
  const candidateSkeleton = confusableSkeleton(candidateUsername);
  const rawSimilarity = editSimilarity(protectedUsername, candidateUsername);
  const skeletonSimilarity = editSimilarity(protectedSkeleton, candidateSkeleton);
  const score = Math.max(rawSimilarity, skeletonSimilarity);
  const distance = levenshteinDistance(protectedUsername, candidateUsername);
  const visualMatch = protectedSkeleton === candidateSkeleton && protectedUsername !== candidateUsername;

  return {
    kind: 'username',
    score,
    contribution: contribution(score, 55),
    explanation: visualMatch
      ? '使用者名稱只含常見視覺混淆字元差異'
      : `使用者名稱編輯距離為 ${distance}`,
  };
}

function optionalTextSignal(
  kind: 'display-name' | 'bio',
  left: string | undefined,
  right: string | undefined,
  weight: number,
  explanation: string,
): SimilaritySignal | undefined {
  if (!left || !right) return undefined;
  const exact = normalizeText(left) === normalizeText(right);
  const score = exact ? 1 : tokenSimilarity(left, right);
  return { kind, score, contribution: contribution(score, weight), explanation };
}

function reviewPriority(score: number): ReviewPriority {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function assessProfileSimilarity(
  protectedProfile: ProfileSignals,
  candidateProfile: ProfileSignals,
): SimilarityAssessment {
  const protectedUsername = parseUsername(protectedProfile.username);
  const candidateUsername = parseUsername(candidateProfile.username);
  const signals: SimilaritySignal[] = [usernameSignal(protectedUsername, candidateUsername)];

  const displayName = optionalTextSignal(
    'display-name',
    protectedProfile.displayName,
    candidateProfile.displayName,
    15,
    '顯示名稱相同或包含重疊詞彙',
  );
  if (displayName) signals.push(displayName);

  if (candidateProfile.avatarSimilarity !== undefined) {
    const score = clampUnit(candidateProfile.avatarSimilarity);
    signals.push({
      kind: 'avatar',
      score,
      contribution: contribution(score, 15),
      explanation: '頭像衍生指紋相似；原圖仍需由使用者目視確認',
    });
  }

  const bio = optionalTextSignal(
    'bio',
    protectedProfile.bio,
    candidateProfile.bio,
    10,
    '簡介文字包含重疊詞彙',
  );
  if (bio) signals.push(bio);

  if (protectedProfile.externalUrl && candidateProfile.externalUrl) {
    const score = urlSimilarity(protectedProfile.externalUrl, candidateProfile.externalUrl);
    signals.push({
      kind: 'external-link',
      score,
      contribution: contribution(score, 5),
      explanation: '外部連結的主機或路徑相似',
    });
  }

  const score = Math.min(
    100,
    signals.reduce((sum, signal) => sum + signal.contribution, 0),
  );
  const priority = reviewPriority(score);

  return { score, priority, signals, disclaimer: DISCLAIMER };
}
