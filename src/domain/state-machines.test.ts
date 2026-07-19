import { describe, expect, it } from 'vitest';

import {
  classifyActionResult,
  InvalidStateTransitionError,
  transitionApproval,
  transitionCandidate,
  transitionJob,
} from './state-machines';

describe('candidate state machine', () => {
  it('supports the review path without making similarity a verdict', () => {
    expect(transitionCandidate('new', 'scan_found')).toBe('pending_review');
    expect(transitionCandidate('pending_review', 'mark_watching')).toBe('watching');
    expect(transitionCandidate('watching', 'prepare_block')).toBe('preparing_block');
  });

  it('forces an uncertain destructive result into manual review', () => {
    expect(transitionCandidate('blocking', 'result_unknown')).toBe('needs_review');
    expect(() => transitionCandidate('needs_review', 'start_block')).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('keeps blocked candidates terminal', () => {
    expect(() => transitionCandidate('blocked', 'prepare_block')).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('approval state machine', () => {
  it('requires reauthentication before issuing and consuming once', () => {
    expect(transitionApproval('draft', 'request_reauth')).toBe('awaiting_reauth');
    expect(transitionApproval('awaiting_reauth', 'issue')).toBe('issued');
    expect(transitionApproval('issued', 'begin_consumption')).toBe('consuming');
    expect(transitionApproval('consuming', 'confirm_consumed')).toBe('consumed');
  });

  it('never moves a consuming approval back to issued', () => {
    expect(transitionApproval('consuming', 'result_unknown')).toBe('needs_review');
    expect(() => transitionApproval('needs_review', 'begin_consumption')).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('job state machine', () => {
  it('requires evidence and audit before success', () => {
    let phase = transitionJob('received', 'authorize');
    phase = transitionJob(phase, 'fix_scope');
    phase = transitionJob(phase, 'wait_for_lock');
    phase = transitionJob(phase, 'verify_connection');
    phase = transitionJob(phase, 'start');
    phase = transitionJob(phase, 'write_evidence');
    phase = transitionJob(phase, 'commit_audit');
    phase = transitionJob(phase, 'succeed');
    expect(phase).toBe('succeeded');
  });

  it('does not allow stop-before-action after execution is running', () => {
    expect(() => transitionJob('running', 'stop_before_action')).toThrow(
      InvalidStateTransitionError,
    );
    expect(transitionJob('running', 'result_unknown')).toBe('needs_review');
  });
});

describe('user-facing action result', () => {
  it('exposes only confirmed, stopped or unknown classifications', () => {
    expect(classifyActionResult('succeeded', 'blocked')).toBe('confirmed_success');
    expect(classifyActionResult('stopped', 'preparing_block')).toBe('stopped_not_executed');
    expect(classifyActionResult('needs_review', 'needs_review')).toBe('unknown_needs_review');
  });
});
