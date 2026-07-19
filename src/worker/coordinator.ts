import type { ConnectionCoordinator } from '../durable-objects/connection-coordinator';
import type { AppBindings } from './environment';

export interface ConnectionCoordinatorAddress {
  ownerDigest: string;
  stub: DurableObjectStub<ConnectionCoordinator>;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveConnectionOwnerDigest(
  namespaceKey: string | undefined,
  tenantId: string,
  connectionId: string,
): Promise<string> {
  if (!namespaceKey || new TextEncoder().encode(namespaceKey).byteLength < 32) {
    throw new Error('Connection coordinator is not configured');
  }
  if (!tenantId || !connectionId) throw new TypeError('Invalid connection ownership scope');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(namespaceKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`threads-connection-v1\0${tenantId}\0${connectionId}`),
    ),
  );
}

export async function connectionCoordinator(
  bindings: Pick<AppBindings, 'CONNECTION_COORDINATOR' | 'COORDINATOR_NAMESPACE_KEY'>,
  tenantId: string,
  connectionId: string,
): Promise<ConnectionCoordinatorAddress> {
  const ownerDigest = await deriveConnectionOwnerDigest(
    bindings.COORDINATOR_NAMESPACE_KEY,
    tenantId,
    connectionId,
  );
  const id = bindings.CONNECTION_COORDINATOR.idFromName(ownerDigest);
  return { ownerDigest, stub: bindings.CONNECTION_COORDINATOR.get(id) };
}
