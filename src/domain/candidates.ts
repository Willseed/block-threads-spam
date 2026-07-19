import { MAX_USERNAME_LENGTH, parseUsername } from './usernames';

export const VARIANT_RULES = [
  'visual-substitution',
  'punctuation',
  'deletion',
  'repetition',
  'insertion',
  'transposition',
  'prefix',
  'suffix',
] as const;

export type VariantRule = (typeof VARIANT_RULES)[number];

export interface CandidateVariant {
  username: string;
  rules: VariantRule[];
  reasons: string[];
}

export interface CandidateGenerationOptions {
  totalLimit?: number;
  perRuleLimit?: number;
  enabledRules?: readonly VariantRule[];
  insertionCharacters?: readonly string[];
  affixes?: readonly string[];
}

interface CandidateReason {
  username: string;
  reason: string;
}

const DEFAULT_TOTAL_LIMIT = 100;
const DEFAULT_PER_RULE_LIMIT = 20;
const DEFAULT_INSERTION_CHARACTERS = ['0', '1'] as const;
const DEFAULT_AFFIXES = ['real', 'official'] as const;

const VISUAL_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  o: ['0'],
  '0': ['o'],
  l: ['1', 'i'],
  i: ['1', 'l'],
  '1': ['l', 'i'],
};

const RULE_REASONS: Readonly<Record<VariantRule, string>> = {
  'visual-substitution': '使用一個常見的視覺混淆字元替換',
  punctuation: '在原名稱附近加入、移除或替換標點',
  deletion: '刪除原名稱中的一個字元',
  repetition: '重複原名稱中的一個字元',
  insertion: '插入一個受控字元',
  transposition: '交換一組相鄰字元',
  prefix: '加入受控的常見前綴',
  suffix: '加入受控的常見後綴',
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return selected;
}

function withinUsernameLength(username: string): boolean {
  return username.length <= MAX_USERNAME_LENGTH;
}

function visualSubstitutions(username: string): CandidateReason[] {
  const candidates: CandidateReason[] = [];
  for (const [index, character] of [...username].entries()) {
    for (const replacement of VISUAL_SUBSTITUTIONS[character] ?? []) {
      candidates.push({
        username: `${username.slice(0, index)}${replacement}${username.slice(index + 1)}`,
        reason: `${RULE_REASONS['visual-substitution']}：${character} → ${replacement}`,
      });
    }
  }
  return candidates;
}

function punctuationVariants(username: string): CandidateReason[] {
  const candidates: CandidateReason[] = [];

  for (const [index, character] of [...username].entries()) {
    if (character === '.' || character === '_') {
      const without = `${username.slice(0, index)}${username.slice(index + 1)}`;
      const replacement = character === '.' ? '_' : '.';
      candidates.push(
        ...[
          { username: without, reason: `${RULE_REASONS.punctuation}：移除 ${character}` },
          {
            username: `${username.slice(0, index)}${replacement}${username.slice(index + 1)}`,
            reason: `${RULE_REASONS.punctuation}：${character} → ${replacement}`,
          },
        ],
      );
    }
  }

  for (let index = 1; index < username.length; index += 1) {
    const left = username[index - 1];
    const right = username[index];
    if (left === '.' || left === '_' || right === '.' || right === '_') continue;
    candidates.push(
      ...['.', '_'].map((punctuation) => ({
        username: `${username.slice(0, index)}${punctuation}${username.slice(index)}`,
        reason: `${RULE_REASONS.punctuation}：加入 ${punctuation}`,
      })),
    );
  }

  return candidates;
}

function deletionVariants(username: string): CandidateReason[] {
  return [...username].map((character, index) => ({
    username: `${username.slice(0, index)}${username.slice(index + 1)}`,
    reason: `${RULE_REASONS.deletion}：${character}`,
  }));
}

function repetitionVariants(username: string): CandidateReason[] {
  return [...username].map((character, index) => ({
    username: `${username.slice(0, index)}${character}${username.slice(index)}`,
    reason: `${RULE_REASONS.repetition}：${character}`,
  }));
}

function insertionVariants(
  username: string,
  insertionCharacters: readonly string[],
): CandidateReason[] {
  const candidates: CandidateReason[] = [];
  for (let index = 0; index <= username.length; index += 1) {
    for (const character of insertionCharacters) {
      candidates.push({
        username: `${username.slice(0, index)}${character}${username.slice(index)}`,
        reason: `${RULE_REASONS.insertion}：${character}`,
      });
    }
  }
  return candidates;
}

function transpositionVariants(username: string): CandidateReason[] {
  const candidates: CandidateReason[] = [];
  for (let index = 0; index < username.length - 1; index += 1) {
    const left = username[index];
    const right = username[index + 1];
    if (left === right) continue;
    candidates.push({
      username: `${username.slice(0, index)}${right}${left}${username.slice(index + 2)}`,
      reason: `${RULE_REASONS.transposition}：${left}${right} → ${right}${left}`,
    });
  }
  return candidates;
}

function affixVariants(
  username: string,
  affixes: readonly string[],
  position: 'prefix' | 'suffix',
): CandidateReason[] {
  return affixes.flatMap((affix) => {
    const variants =
      position === 'prefix'
        ? [`${affix}${username}`, `${affix}.${username}`, `${affix}_${username}`]
        : [`${username}${affix}`, `${username}.${affix}`, `${username}_${affix}`];
    return variants.map((variant) => ({
      username: variant,
      reason: `${RULE_REASONS[position]}：${affix}`,
    }));
  });
}

function validateControlledCharacters(characters: readonly string[]): readonly string[] {
  return characters.map((character) => {
    let parsed: string;
    try {
      parsed = parseUsername(character);
    } catch {
      throw new RangeError('insertionCharacters must contain single alphanumeric characters');
    }
    if (parsed.length !== 1 || parsed === '.' || parsed === '_') {
      throw new RangeError('insertionCharacters must contain single alphanumeric characters');
    }
    return parsed;
  });
}

function validateAffixes(affixes: readonly string[]): readonly string[] {
  return affixes.map((affix) => {
    let parsed: string;
    try {
      parsed = parseUsername(affix);
    } catch {
      throw new RangeError('affixes must be alphanumeric');
    }
    if (parsed.includes('.') || parsed.includes('_')) {
      throw new RangeError('affixes must be alphanumeric');
    }
    return parsed;
  });
}

export function generateCandidateVariants(
  protectedUsernameInput: string,
  options: CandidateGenerationOptions = {},
): CandidateVariant[] {
  const protectedUsername = parseUsername(protectedUsernameInput);
  const totalLimit = positiveInteger(options.totalLimit, DEFAULT_TOTAL_LIMIT, 'totalLimit');
  const perRuleLimit = positiveInteger(
    options.perRuleLimit,
    DEFAULT_PER_RULE_LIMIT,
    'perRuleLimit',
  );
  const insertionCharacters = validateControlledCharacters(
    options.insertionCharacters ?? DEFAULT_INSERTION_CHARACTERS,
  );
  const affixes = validateAffixes(options.affixes ?? DEFAULT_AFFIXES);
  const enabledRules = new Set(options.enabledRules ?? VARIANT_RULES);

  const factories: Readonly<Record<VariantRule, () => CandidateReason[]>> = {
    'visual-substitution': () => visualSubstitutions(protectedUsername),
    punctuation: () => punctuationVariants(protectedUsername),
    deletion: () => deletionVariants(protectedUsername),
    repetition: () => repetitionVariants(protectedUsername),
    insertion: () => insertionVariants(protectedUsername, insertionCharacters),
    transposition: () => transpositionVariants(protectedUsername),
    prefix: () => affixVariants(protectedUsername, affixes, 'prefix'),
    suffix: () => affixVariants(protectedUsername, affixes, 'suffix'),
  };

  const collected = new Map<string, CandidateVariant>();

  for (const rule of VARIANT_RULES) {
    if (!enabledRules.has(rule)) continue;
    let acceptedForRule = 0;

    for (const candidate of factories[rule]()) {
      if (acceptedForRule >= perRuleLimit || collected.size >= totalLimit) break;
      if (candidate.username === protectedUsername || !withinUsernameLength(candidate.username)) continue;

      let parsed: string;
      try {
        parsed = parseUsername(candidate.username);
      } catch {
        continue;
      }

      const existing = collected.get(parsed);
      if (existing) {
        if (!existing.rules.includes(rule)) existing.rules.push(rule);
        if (!existing.reasons.includes(candidate.reason)) existing.reasons.push(candidate.reason);
        continue;
      }

      collected.set(parsed, {
        username: parsed,
        rules: [rule],
        reasons: [candidate.reason],
      });
      acceptedForRule += 1;
    }

    if (collected.size >= totalLimit) break;
  }

  return [...collected.values()];
}
