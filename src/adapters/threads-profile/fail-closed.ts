/* eslint-disable @typescript-eslint/no-unused-vars */
import type {
  ProfileLookupRequest,
  ProfileLookupResult,
  ThreadsProfileAdapter,
} from './types';

export class FailClosedThreadsProfileAdapter implements ThreadsProfileAdapter {
  lookup(_request: ProfileLookupRequest): Promise<ProfileLookupResult> {
    return Promise.resolve({ status: 'unavailable', reason: 'capability_unavailable' });
  }
}
