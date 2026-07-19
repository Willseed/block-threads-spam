export interface ThreadsPublicProfile {
  platformId?: string;
  username: string;
  displayName?: string;
  biography?: string;
  profilePictureUrl?: string;
  isVerified?: boolean;
  followerCount?: number;
}

export type ProfileLookupFailure =
  | 'capability_unavailable'
  | 'permission_denied'
  | 'rate_limited'
  | 'temporary_unavailable'
  | 'malformed_response';

export type ProfileLookupResult =
  | { status: 'found'; profile: ThreadsPublicProfile }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: ProfileLookupFailure };

export interface ProfileLookupRequest {
  username: string;
  accessToken: string;
}

export interface ThreadsProfileAdapter {
  lookup(request: ProfileLookupRequest): Promise<ProfileLookupResult>;
}
