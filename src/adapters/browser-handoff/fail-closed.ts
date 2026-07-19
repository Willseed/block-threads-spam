import { HandoffCapabilityError } from './types';
import type {
  BrowserHandoffProvider,
  HandoffScope,
  PreparedBrowserHandoff,
} from './types';

export class FailClosedBrowserHandoffProvider implements BrowserHandoffProvider {
  isAvailable(): boolean {
    return false;
  }

  prepare(scope: HandoffScope): Promise<PreparedBrowserHandoff> {
    void scope;
    return Promise.reject(new HandoffCapabilityError());
  }

  liveViewUrl(
    prepared: PreparedBrowserHandoff,
    scope: HandoffScope,
  ): Promise<string> {
    void prepared;
    void scope;
    return Promise.reject(new HandoffCapabilityError());
  }

  verify(
    prepared: PreparedBrowserHandoff,
    scope: HandoffScope,
  ): Promise<'confirmed' | 'unknown' | 'target_mismatch'> {
    void prepared;
    void scope;
    return Promise.reject(new HandoffCapabilityError());
  }

  close(browserSessionId: string): Promise<void> {
    void browserSessionId;
    return Promise.resolve();
  }
}
