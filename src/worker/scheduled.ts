import { assessProfileSimilarity } from '../domain/similarity';
import { D1Repository } from '../platform/d1/repository';
import { SchedulerRepository } from '../platform/d1/scheduler-repository';
import { D1RateLimiter } from '../platform/d1/rate-limiter';
import { MetaLifecycleRepository } from '../platform/d1/meta-lifecycle-repository';
import { R2EvidenceRepository } from '../platform/r2/evidence-repository';
import { connectionCoordinator } from './coordinator';
import type { AppBindings } from './environment';
import { runMetaLifecycleRetries } from './meta-lifecycle/processor';

interface ProfileForSimilarity {
  username: string;
  displayName?: string;
  biography?: string;
}

function profileForSimilarity(profile: ProfileForSimilarity) {
  const comparable: { username: string; displayName?: string; bio?: string } = {
    username: profile.username,
  };
  if (profile.displayName) comparable.displayName = profile.displayName;
  if (profile.biography) comparable.bio = profile.biography;
  return comparable;
}

export async function runScheduledScans(bindings: AppBindings): Promise<number> {
  if (bindings.FEATURE_META_PROFILE_LOOKUP !== 'true') return 0;
  const scheduler = new SchedulerRepository(bindings.DB);
  const dueSchedules = await scheduler.claimDueSchedules(10);
  let completed = 0;

  for (const schedule of dueSchedules) {
    let succeeded = false;
    try {
      const candidate = await scheduler.nextCandidate(schedule);
      if (!candidate) {
        succeeded = true;
        completed += 1;
        continue;
      }
      const coordinator = await connectionCoordinator(
        bindings,
        schedule.tenant.tenantId,
        schedule.connectionId,
      );
      const jobId = `scheduled-refresh-${crypto.randomUUID()}`;
      const lease = await coordinator.stub.acquire({
        ownerDigest: coordinator.ownerDigest,
        revocationVersion: schedule.revocationVersion,
        jobId,
        kind: 'candidate_refresh',
        ttlSeconds: 60,
      });
      if (lease.status !== 'acquired') continue;

      try {
        const lookup = await coordinator.stub.lookupProfile(
          coordinator.ownerDigest,
          candidate.username,
        );
        const update =
          lookup.status === 'found'
            ? {
                status: 'found' as const,
                profile: lookup.profile,
                assessment: assessProfileSimilarity(
                  { username: schedule.protectedUsername },
                  profileForSimilarity(lookup.profile),
                ),
              }
            : lookup;
        const repository = new D1Repository(bindings.DB);
        await repository.recordCandidateLookup(
          schedule.tenant,
          schedule.connectionId,
          candidate.id,
          update,
        );
        await scheduler.deferCandidate(candidate.id, lookup);
        succeeded = true;
        completed += 1;
      } finally {
        await coordinator.stub.release(coordinator.ownerDigest, jobId, lease.generation);
      }
    } catch {
      succeeded = false;
    } finally {
      await scheduler.finishSchedule(schedule.connectionId, succeeded);
    }
  }
  return completed;
}

export async function runMaintenance(bindings: AppBindings): Promise<number> {
  const lifecycle = await runMetaLifecycleRetries(bindings, 10);
  const lifecycleRepository = new MetaLifecycleRepository(bindings.DB);
  const evidence = new R2EvidenceRepository(bindings.DB, bindings.EVIDENCE);
  const [evidenceCount, rateLimitCount, receiptCount] = await Promise.all([
    evidence.purgeExpired(100),
    new D1RateLimiter(bindings.DB).purgeExpired(1000),
    lifecycleRepository.purgeExpiredReceipts(100),
  ]);
  return evidenceCount + rateLimitCount + receiptCount + lifecycle.claimed;
}
