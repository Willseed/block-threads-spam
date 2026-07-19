export interface HandoffScope {
  handoffId: string;
  approvedUsername: string;
  approvedPlatformId: string;
  absoluteDeadlineAt: string;
}

export interface PreparedBrowserHandoff {
  browserSessionId: string;
  targetId: string;
}

export interface BrowserHandoffProvider {
  isAvailable(): boolean;
  prepare(scope: HandoffScope): Promise<PreparedBrowserHandoff>;
  liveViewUrl(prepared: PreparedBrowserHandoff, scope: HandoffScope): Promise<string>;
  verify(
    prepared: PreparedBrowserHandoff,
    scope: HandoffScope,
  ): Promise<'confirmed' | 'unknown' | 'target_mismatch'>;
  close(browserSessionId: string): Promise<void>;
}

export class HandoffCapabilityError extends Error {
  constructor() {
    super('Browser handoff capability is unavailable');
    this.name = 'HandoffCapabilityError';
  }
}
