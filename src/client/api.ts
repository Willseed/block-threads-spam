export interface Identity {
  subject: string;
  email?: string;
  authenticatedAt?: string;
}

export interface Connection {
  id: string;
  protectedUsername: string;
  platformUserId?: string;
  connectionMode: 'meta_oauth' | 'manual_handoff';
  status:
    | 'awaiting_identity_confirmation'
    | 'connected'
    | 'reauth_required'
    | 'challenge_required'
    | 'revoking'
    | 'revoked';
  createdAt: string;
  revocationVersion: number;
  lastVerifiedAt?: string;
}

export interface Candidate {
  id: string;
  username: string;
  sourceType: 'generated' | 'manual' | 'historical';
  sourceRules: string[];
  reasons: string[];
  status: string;
  priority: 'low' | 'medium' | 'high';
  firstSeenAt: string;
}

export interface ActivityEvent {
  id: string;
  connectionId?: string;
  eventType: string;
  targetRef?: string;
  createdAt: string;
}

export interface SchedulePreference {
  enabled: boolean;
  timezone: string;
  frequencyPolicy: 'daily_low_frequency';
  nextRunAt?: string;
  lastRunAt?: string;
}

export interface Capabilities {
  officialProfileLookup: boolean;
  manualBlockHandoff: boolean;
  automatedBlock: false;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? '要求失敗，請稍後再試。');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error?.code;
  }
}

function encodePathSegment(segment: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error('Invalid path segment');
  }
  return encodeURIComponent(segment);
}

function apiPath(...segments: string[]): string {
  return `/api/${segments.map(encodePathSegment).join('/')}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!path.startsWith('/api/')) {
    throw new Error('Invalid API request path');
  }
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as T;
}

export const api = {
  identity: () => request<Identity>('/api/me'),
  capabilities: () => request<{ capabilities: Capabilities }>('/api/capabilities'),
  connections: () => request<{ connections: Connection[] }>('/api/connections'),
  createConnection: (protectedUsername: string) =>
    request<{ connection: Connection }>(apiPath('connections'), {
      method: 'POST',
      body: JSON.stringify({ protectedUsername, connectionMode: 'meta_oauth' }),
    }),
  candidates: (connectionId: string) =>
    request<{ candidates: Candidate[] }>(apiPath('connections', connectionId, 'candidates')),
  addCandidate: (connectionId: string, username: string) =>
    request<{ candidate: Candidate }>(apiPath('connections', connectionId, 'candidates'), {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  generateCandidates: (connectionId: string) =>
    request<{
      snapshot: { generated: number; created: number };
      candidates: Candidate[];
    }>(apiPath('connections', connectionId, 'candidates', 'generate'), {
      method: 'POST',
      body: JSON.stringify({ totalLimit: 80, perRuleLimit: 12 }),
    }),
  refreshCandidate: (connectionId: string, candidateId: string) =>
    request<{ candidate: Candidate }>(
      apiPath('connections', connectionId, 'candidates', candidateId, 'refresh'),
      { method: 'POST' },
    ),
  decideCandidate: (
    connectionId: string,
    candidateId: string,
    action: 'watch' | 'ignore' | 'resume',
  ) =>
    request<{ candidate: Candidate }>(
      apiPath('connections', connectionId, 'candidates', candidateId),
      {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      },
    ),
  activity: () => request<{ events: ActivityEvent[] }>(`${apiPath('activity')}?limit=50`),
  startOAuth: (connectionId: string) =>
    request<{ authorizationUrl: string; expiresAt: string }>(
      apiPath('connections', connectionId, 'oauth', 'start'),
      { method: 'POST' },
    ),
  confirmOAuth: (connectionId: string, username: string) =>
    request<{ connection: Connection }>(apiPath('connections', connectionId, 'oauth', 'confirm'), {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  schedule: (connectionId: string) => request<{ schedule: SchedulePreference }>(apiPath('connections', connectionId, 'schedule')),
  updateSchedule: (connectionId: string, enabled: boolean, timezone: string) =>
    request<{ schedule: SchedulePreference }>(apiPath('connections', connectionId, 'schedule'), {
      method: 'PATCH',
      body: JSON.stringify({ enabled, timezone }),
    }),
  issueApproval: (connectionId: string, candidateId: string, exactTargetUsername: string) =>
    request<{
      approval: { id: string; expiresAt: string };
      actionToken: string;
    }>(apiPath('connections', connectionId, 'candidates', candidateId, 'approvals'), {
      method: 'POST',
      body: JSON.stringify({ exactTargetUsername }),
    }),
  startHandoff: (approvalId: string, actionToken: string) =>
    request<{
      handoff: { id: string; enterPath: string; expiresAt: string; exactTargetUsername: string };
    }>('/api/handoffs', {
      method: 'POST',
      body: JSON.stringify({ approvalId, actionToken }),
    }),
  completeHandoff: (handoffId: string) =>
    request<{
      result: {
        status: 'confirmed_success' | 'unknown_needs_review';
        exactTargetUsername: string;
      };
    }>(apiPath('handoffs', handoffId, 'complete'), { method: 'POST' }),
  revokeConnection: (connectionId: string, dataRetention: 'retain' | 'delete') =>
    request<{ connection: Connection }>(apiPath('connections', connectionId), {
      method: 'DELETE',
      body: JSON.stringify({ dataRetention }),
    }),
};
