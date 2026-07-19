import { DurableObject } from 'cloudflare:workers';

import type { AppBindings } from '../worker/environment';

export type ConnectionJobKind =
  | 'connect'
  | 'scan'
  | 'candidate_refresh'
  | 'manual_block'
  | 'health_check'
  | 'revoke';

export interface AcquireLeaseInput {
  ownerDigest: string;
  revocationVersion: number;
  jobId: string;
  kind: ConnectionJobKind;
  ttlSeconds: number;
}

export type AcquireLeaseResult =
  | {
      status: 'acquired';
      generation: number;
      expiresAt: string;
      idempotent: boolean;
    }
  | { status: 'busy'; activeKind: ConnectionJobKind; expiresAt: string }
  | { status: 'revoked'; revocationVersion: number }
  | { status: 'stale_revocation_version'; revocationVersion: number }
  | { status: 'ownership_mismatch' };

interface ConnectionLease {
  jobId: string;
  kind: ConnectionJobKind;
  generation: number;
  expiresAtMs: number;
}

interface CoordinatorState {
  ownerDigest: string;
  revocationVersion: number;
  revoked: boolean;
  lastGeneration: number;
  lease?: ConnectionLease;
}

export interface CoordinatorStatus {
  revocationVersion: number;
  revoked: boolean;
  lease?: {
    kind: ConnectionJobKind;
    generation: number;
    expiresAt: string;
  };
}

const STATE_KEY = 'coordinator-state';

function assertOwnerDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid owner digest');
}

function assertJobId(value: string): void {
  if (value.length === 0 || value.length > 128) throw new TypeError('Invalid job ID');
}

function assertRevocationVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid revocation version');
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 5 || value > 600) {
    throw new RangeError('Lease TTL must be between 5 and 600 seconds');
  }
}

function ownerMatches(state: CoordinatorState, ownerDigest: string): boolean {
  return state.ownerDigest === ownerDigest;
}

export class ConnectionCoordinator extends DurableObject<AppBindings> {
  async acquire(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    assertOwnerDigest(input.ownerDigest);
    assertJobId(input.jobId);
    assertRevocationVersion(input.revocationVersion);
    assertTtl(input.ttlSeconds);

    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      let state = await transaction.get<CoordinatorState>(STATE_KEY);
      if (!state) {
        state = {
          ownerDigest: input.ownerDigest,
          revocationVersion: input.revocationVersion,
          revoked: false,
          lastGeneration: 0,
        };
      } else {
        if (!ownerMatches(state, input.ownerDigest)) return { status: 'ownership_mismatch' };
      }

      if (state.revoked) {
        return { status: 'revoked', revocationVersion: state.revocationVersion };
      }
      if (state.revocationVersion !== input.revocationVersion) {
        return {
          status: 'stale_revocation_version',
          revocationVersion: state.revocationVersion,
        };
      }

      if (state.lease && state.lease.expiresAtMs > now) {
        if (state.lease.jobId === input.jobId) {
          return {
            status: 'acquired',
            generation: state.lease.generation,
            expiresAt: new Date(state.lease.expiresAtMs).toISOString(),
            idempotent: true,
          };
        }
        return {
          status: 'busy',
          activeKind: state.lease.kind,
          expiresAt: new Date(state.lease.expiresAtMs).toISOString(),
        };
      }

      const generation = state.lastGeneration + 1;
      const expiresAtMs = now + input.ttlSeconds * 1000;
      state.lastGeneration = generation;
      state.lease = {
        jobId: input.jobId,
        kind: input.kind,
        generation,
        expiresAtMs,
      };
      await transaction.put(STATE_KEY, state);
      return {
        status: 'acquired',
        generation,
        expiresAt: new Date(expiresAtMs).toISOString(),
        idempotent: false,
      };
    });
  }

  async release(ownerDigest: string, jobId: string, generation: number): Promise<boolean> {
    assertOwnerDigest(ownerDigest);
    assertJobId(jobId);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new TypeError('Invalid lease generation');
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get<CoordinatorState>(STATE_KEY);
      if (!state) return false;
      if (!ownerMatches(state, ownerDigest)) return false;
      if (state.lease?.jobId !== jobId || state.lease.generation !== generation) return false;
      delete state.lease;
      await transaction.put(STATE_KEY, state);
      return true;
    });
  }

  async revoke(ownerDigest: string, expectedVersion: number): Promise<number | undefined> {
    assertOwnerDigest(ownerDigest);
    assertRevocationVersion(expectedVersion);

    return this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get<CoordinatorState>(STATE_KEY);
      if (!state) throw new Error('Coordinator is not initialized');
      if (!ownerMatches(state, ownerDigest)) return undefined;
      if (state.revocationVersion !== expectedVersion) return undefined;
      state.revocationVersion += 1;
      state.revoked = true;
      delete state.lease;
      await transaction.put(STATE_KEY, state);
      return state.revocationVersion;
    });
  }

  async status(ownerDigest: string): Promise<CoordinatorStatus | undefined> {
    assertOwnerDigest(ownerDigest);
    const state = await this.ctx.storage.get<CoordinatorState>(STATE_KEY);
    if (!state) return undefined;
    if (!ownerMatches(state, ownerDigest)) return undefined;
    const activeLease = state.lease && state.lease.expiresAtMs > Date.now() ? state.lease : undefined;
    return {
      revocationVersion: state.revocationVersion,
      revoked: state.revoked,
      ...(activeLease
        ? {
            lease: {
              kind: activeLease.kind,
              generation: activeLease.generation,
              expiresAt: new Date(activeLease.expiresAtMs).toISOString(),
            },
          }
        : {}),
    };
  }
}
