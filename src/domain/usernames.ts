const THREADS_USERNAME_PATTERN = /^(?!.*\.\.)(?!\.)(?!.*\.$)[a-z0-9._]+$/;

export const MAX_USERNAME_LENGTH = 30;

export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(`Invalid Threads username: ${username}`);
    this.name = 'InvalidUsernameError';
  }
}

export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLocaleLowerCase('en-US');
}

export function assertValidUsername(value: string): asserts value is string {
  if (
    value.length === 0 ||
    value.length > MAX_USERNAME_LENGTH ||
    !THREADS_USERNAME_PATTERN.test(value)
  ) {
    throw new InvalidUsernameError(value);
  }
}

export function parseUsername(value: string): string {
  const normalized = normalizeUsername(value);
  assertValidUsername(normalized);
  return normalized;
}
