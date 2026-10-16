// ---------------------------------------------------------------------------
// cloud-backends.ts — one client per configuration, reused
// ---------------------------------------------------------------------------
//
// Configuration is resolved per request (so a changed .env is honoured), but an
// SDK client must NOT be created per request: each AWS SDK v3 client resolves
// its own credentials, so a new client per request re-runs the credential chain
// (an instance-metadata or STS round trip) every time. Clients are cached by
// their resolved configuration; a changed setting simply produces a new one.
// A failed creation is not cached, so a fixed configuration takes effect.
// ---------------------------------------------------------------------------

import type { AzureBackendConfig } from '../storage/cloud/azure-backend.js';
import type { S3BackendConfig } from '../storage/cloud/s3-backend.js';
import type { CloudBackend } from '../storage/cloud/types.js';

const cache = new Map<string, Promise<CloudBackend>>();

/**
 * Bounded: credentials rotated through options (a new STS session token per
 * deploy, say) produce a new configuration each time, and an unbounded cache
 * would keep every superseded client alive. The least recently used goes first.
 */
const MAX_CACHED_BACKENDS = 8;

export function cloudBackendFor(config: S3BackendConfig | AzureBackendConfig): Promise<CloudBackend> {
  // The key holds credentials, in memory only; it is never logged or returned.
  const key = JSON.stringify(config);
  let backend = cache.get(key);
  if (backend) {
    // Re-inserted, so Map order is least recently used first.
    cache.delete(key);
    cache.set(key, backend);
  } else {
    if (cache.size >= MAX_CACHED_BACKENDS) cache.delete(cache.keys().next().value as string);
    backend = (async () => {
      if (config.kind === 'azure_blob') {
        const { createAzureBackend } = await import('../storage/cloud/azure-backend.js');
        return createAzureBackend(config);
      }
      const { createS3Backend } = await import('../storage/cloud/s3-backend.js');
      return createS3Backend(config);
    })();
    cache.set(key, backend);
    // Only THIS entry: after an eviction a newer one may be cached under the key.
    const created = backend;
    created.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  return backend;
}
