export type CandidateState =
  | 'new'
  | 'pending_review'
  | 'watching'
  | 'ignored'
  | 'preparing_block'
  | 'blocking'
  | 'blocked'
  | 'needs_review'
  | 'not_found'
  | 'lookup_unavailable';

export type CandidateEvent =
  | 'scan_found'
  | 'scan_not_found'
  | 'scan_unavailable'
  | 'mark_watching'
  | 'ignore'
  | 'prepare_block'
  | 'cancel_block'
  | 'start_block'
  | 'confirm_blocked'
  | 'result_unknown'
  | 'resolve_not_blocked';

export type ApprovalState =
  | 'draft'
  | 'awaiting_reauth'
  | 'issued'
  | 'consuming'
  | 'consumed'
  | 'expired'
  | 'revoked'
  | 'needs_review';

export type ApprovalEvent =
  | 'request_reauth'
  | 'issue'
  | 'begin_consumption'
  | 'confirm_consumed'
  | 'expire'
  | 'revoke'
  | 'result_unknown';

export type JobPhase =
  | 'received'
  | 'authorized'
  | 'scope_fixed'
  | 'waiting_for_lock'
  | 'connection_verified'
  | 'running'
  | 'evidence_written'
  | 'audit_committed'
  | 'succeeded'
  | 'stopped'
  | 'needs_review';

export type JobEvent =
  | 'authorize'
  | 'fix_scope'
  | 'wait_for_lock'
  | 'verify_connection'
  | 'start'
  | 'write_evidence'
  | 'commit_audit'
  | 'succeed'
  | 'stop_before_action'
  | 'result_unknown';

export type UserFacingActionResult =
  | 'confirmed_success'
  | 'stopped_not_executed'
  | 'unknown_needs_review';

export class InvalidStateTransitionError extends Error {
  constructor(machine: string, state: string, event: string) {
    super(`Invalid ${machine} transition: ${state} + ${event}`);
    this.name = 'InvalidStateTransitionError';
  }
}

type TransitionTable<State extends string, Event extends string> = Partial<
  Record<State, Partial<Record<Event, State>>>
>;

const CANDIDATE_TRANSITIONS: TransitionTable<CandidateState, CandidateEvent> = {
  new: {
    scan_found: 'pending_review',
    scan_not_found: 'not_found',
    scan_unavailable: 'lookup_unavailable',
  },
  pending_review: {
    scan_not_found: 'not_found',
    scan_unavailable: 'lookup_unavailable',
    mark_watching: 'watching',
    ignore: 'ignored',
    prepare_block: 'preparing_block',
  },
  watching: {
    scan_found: 'pending_review',
    scan_not_found: 'not_found',
    scan_unavailable: 'lookup_unavailable',
    ignore: 'ignored',
    prepare_block: 'preparing_block',
  },
  ignored: {
    mark_watching: 'watching',
    scan_found: 'pending_review',
  },
  preparing_block: {
    cancel_block: 'pending_review',
    start_block: 'blocking',
  },
  blocking: {
    confirm_blocked: 'blocked',
    result_unknown: 'needs_review',
  },
  needs_review: {
    confirm_blocked: 'blocked',
    resolve_not_blocked: 'pending_review',
  },
  not_found: {
    scan_found: 'pending_review',
    mark_watching: 'watching',
    scan_unavailable: 'lookup_unavailable',
  },
  lookup_unavailable: {
    scan_found: 'pending_review',
    scan_not_found: 'not_found',
    mark_watching: 'watching',
  },
};

const APPROVAL_TRANSITIONS: TransitionTable<ApprovalState, ApprovalEvent> = {
  draft: { request_reauth: 'awaiting_reauth', revoke: 'revoked' },
  awaiting_reauth: { issue: 'issued', revoke: 'revoked' },
  issued: {
    begin_consumption: 'consuming',
    expire: 'expired',
    revoke: 'revoked',
  },
  consuming: {
    confirm_consumed: 'consumed',
    result_unknown: 'needs_review',
  },
};

const JOB_TRANSITIONS: TransitionTable<JobPhase, JobEvent> = {
  received: { authorize: 'authorized', stop_before_action: 'stopped' },
  authorized: { fix_scope: 'scope_fixed', stop_before_action: 'stopped' },
  scope_fixed: { wait_for_lock: 'waiting_for_lock', stop_before_action: 'stopped' },
  waiting_for_lock: {
    verify_connection: 'connection_verified',
    stop_before_action: 'stopped',
  },
  connection_verified: { start: 'running', stop_before_action: 'stopped' },
  running: {
    write_evidence: 'evidence_written',
    result_unknown: 'needs_review',
  },
  evidence_written: {
    commit_audit: 'audit_committed',
    result_unknown: 'needs_review',
  },
  audit_committed: { succeed: 'succeeded' },
};

function transition<State extends string, Event extends string>(
  machine: string,
  table: TransitionTable<State, Event>,
  state: State,
  event: Event,
): State {
  const next = table[state]?.[event];
  if (!next) throw new InvalidStateTransitionError(machine, state, event);
  return next;
}

export function transitionCandidate(state: CandidateState, event: CandidateEvent): CandidateState {
  return transition('candidate', CANDIDATE_TRANSITIONS, state, event);
}

export function transitionApproval(state: ApprovalState, event: ApprovalEvent): ApprovalState {
  return transition('approval', APPROVAL_TRANSITIONS, state, event);
}

export function transitionJob(state: JobPhase, event: JobEvent): JobPhase {
  return transition('job', JOB_TRANSITIONS, state, event);
}

export function classifyActionResult(
  jobPhase: JobPhase,
  candidateState: CandidateState,
): UserFacingActionResult {
  if (jobPhase === 'succeeded' && candidateState === 'blocked') return 'confirmed_success';
  if (jobPhase === 'stopped' && candidateState !== 'blocking') return 'stopped_not_executed';
  return 'unknown_needs_review';
}
