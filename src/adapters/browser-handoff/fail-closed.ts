/* eslint-disable @typescript-eslint/no-unused-vars */
import { HandoffCapabilityError } from './types';
import type {
  HandoffScope,
  BrowserHandoffProvider,
  PreparedBrowserHandoff,
} from './types';

export class FailClosedBrowserHandoffProvider implements BrowserHandoffProvider {
  isAvailable(): boolean {
    return false;
  }

  prepare(_scope: HandoffScope): Promise<PreparedBrowserHandoff> {
    return Promise.reject(new HandoffCapabilityError());
  }

  liveViewUrl(
    _prepared: PreparedBrowserHandoff,
    _scope: HandoffScope,
  ): Promise<string> {
    return Promise.reject(new HandoffCapabilityError());
  }

  verify(
    _prepared: PreparedBrowserHandoff,
    _scope: HandoffScope,
  ): Promise<'confirmed' | 'unknown' | 'target_mismatch'> {
    return Promise.reject(new HandoffCapabilityError());
  }

  close(_browserSessionId: string): Promise<void> {
    return Promise.resolve();
  }
}
