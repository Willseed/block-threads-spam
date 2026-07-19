export interface Identity {
  subject: string;
  email?: string;
  authenticatedAt?: string;
}

export interface Connection {
  id: string;
  protectedUsername: string;
  connectionMode: 'meta_oauth' | 'manual_handoff';
  status:
    | 'awaiting_identity_confirmation'
    | 'connected'
    | 'reauth_required'
    | 'challenge_required'
    | 'revoking'
    | 'revoked';
  createdAt: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
  connections: () => request<{ connections: Connection[] }>('/api/connections'),
  createConnection: (protectedUsername: string) =>
    request<{ connection: Connection }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ protectedUsername, connectionMode: 'meta_oauth' }),
    }),
  candidates: (connectionId: string) =>
    request<{ candidates: Candidate[] }>(`/api/connections/${connectionId}/candidates`),
  addCandidate: (connectionId: string, username: string) =>
    request<{ candidate: Candidate }>(`/api/connections/${connectionId}/candidates`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  generateCandidates: (connectionId: string) =>
    request<{
      snapshot: { generated: number; created: number };
      candidates: Candidate[];
    }>(`/api/connections/${connectionId}/candidates/generate`, {
      method: 'POST',
      body: JSON.stringify({ totalLimit: 80, perRuleLimit: 12 }),
    }),
  decideCandidate: (
    connectionId: string,
    candidateId: string,
    action: 'watch' | 'ignore' | 'resume',
  ) =>
    request<{ candidate: Candidate }>(
      `/api/connections/${connectionId}/candidates/${candidateId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      },
    ),
};
