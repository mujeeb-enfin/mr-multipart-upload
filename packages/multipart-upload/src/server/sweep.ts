// ---------------------------------------------------------------------------
// sweep.ts — reclaim abandoned uploads
// ---------------------------------------------------------------------------
//
// A user who starts a 400 MB upload and closes the tab leaves 400 MB behind.
// Nothing else removes it: the happy path deletes only its own session.
//
// NO TIMERS. Callers:
//   1. `begin` sweeps opportunistically (option `sweepOnBegin`, default true).
//      This is the one that works with no operator action at all.
//   2. `uploader.sweep()`, for applications that run it from a cron or an admin
//      action.
//
// TTL IS MEASURED FROM THE NEWEST FILE, not from the manifest. An upload paused
// overnight and resumed in the morning is live work: its manifest is old but its
// latest part is not. Using the manifest's age would reap it mid-flight.
// ---------------------------------------------------------------------------

import { PARTS_DIR, namespaceDirKey, sessionKey } from '../core/layout.js';
import type { StorageAdapter } from '../storage/adapter.js';

export interface SweepResult {
  /** Session directories inspected. */
  scanned: number;
  /** Session directories removed. */
  deleted: number;
  /** Directories that could not be inspected or removed. */
  errors: number;
  freedBytes: number;
}

async function measure(storage: StorageAdapter, dirKey: string): Promise<{ bytes: number; newest: number }> {
  let bytes = 0;
  let newest = 0;
  for (const entry of await storage.list(dirKey)) {
    const info = await storage.stat(`${dirKey}/${entry}`);
    // A file removed mid-scan is not an error: the session is live.
    if (!info || info.isDirectory) continue;
    bytes += info.size;
    newest = Math.max(newest, info.modifiedMs);
  }
  if (newest === 0) {
    // No files at all: use the directory's own age, so an empty leftover is
    // still eligible instead of looking infinitely fresh.
    newest = (await storage.stat(dirKey))?.modifiedMs ?? 0;
  }
  return { bytes, newest };
}

/**
 * `beforeRemove` lets a cloud backend release the provider's side of a stale
 * session (abort the S3 multipart upload, delete the Azure blob) before its
 * control files are removed.
 */
export async function sweepStaleUploads(
  storage: StorageAdapter,
  ttlMs: number,
  beforeRemove?: (dirKey: string) => Promise<void>,
): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, deleted: 0, errors: 0, freedBytes: 0 };
  const cutoff = Date.now() - ttlMs;

  for (const namespaceKey of await storage.list(PARTS_DIR)) {
    if (!/^[0-9a-f]{32}$/.test(namespaceKey)) continue; // not created by this library
    for (const uploadId of await storage.list(namespaceDirKey(namespaceKey))) {
      result.scanned += 1;
      try {
        const dirKey = sessionKey(namespaceKey, uploadId);
        const info = await storage.stat(dirKey);
        if (!info?.isDirectory) continue;
        const { bytes, newest } = await measure(storage, dirKey);
        if (newest >= cutoff) continue;
        if (beforeRemove) await beforeRemove(dirKey);
        await storage.removeTree(dirKey);
        result.deleted += 1;
        result.freedBytes += bytes;
      } catch {
        // One unreadable directory must not stop every other one being reclaimed.
        result.errors += 1;
      }
    }
  }
  return result;
}
