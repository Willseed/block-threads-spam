import type {
  ProfileLookupRequest,
  ProfileLookupResult,
  ThreadsProfileAdapter,
} from './types';

export class FailClosedThreadsProfileAdapter implements ThreadsProfileAdapter {
  lookup(request: ProfileLookupRequest): Promise<ProfileLookupResult> {
    void request;
    return Promise.resolve({ status: 'unavailable', reason: 'capability_unavailable' });
  }
}
