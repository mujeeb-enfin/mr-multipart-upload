// ---------------------------------------------------------------------------
// store.ts — reading a session's state from storage
// ---------------------------------------------------------------------------
//
// There is no database, no session table and no client-side token: the files ARE
// the state. Resume state is derived by LISTING the session directory and
// checking each part's size.
//
// WRONG-SIZE PARTS ARE NOT DELETED HERE. These reads run on every status poll,
// and deleting a short part would race a part that is still being written: the
// writer would be mid-write on an unlinked file (POSIX) or hit a sharing
// violation (Windows), and a good upload would lose a part it had just paid for.
// Pruning happens only in `complete`, under the lock, and in the sweep.
// ---------------------------------------------------------------------------

import { expectedPartBytes } from '../core/arithmetic.js';
import { UploadError } from '../core/errors.js';
import { manifestKey, partIndexFromFileName, partKey, sessionKey } from '../core/layout.js';
import { type UploadManifest, type UploadSession, summariseSession } from '../core/session.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { ResolvedConfig } from './config.js';
import { partTagFor } from './namespace.js';

/** Everything an operation needs once the caller has been authorised. */
export interface StoreContext {
  readonly storage: StorageAdapter;
  readonly config: ResolvedConfig;
  /** Hashed namespace directory of the authorised caller. */
  readonly namespaceKey: string;
}

export async function readManifest(ctx: StoreContext, uploadId: string): Promise<UploadManifest | null> {
  const manifest = await ctx.storage.readJson<UploadManifest>(manifestKey(ctx.namespaceKey, uploadId));
  // A manifest from another layout version cannot be resumed safely — its part
  // boundaries may differ — so it is treated as absent.
  if (!manifest || manifest.v !== 1) return null;
  return manifest;
}

/**
 * Indices present AND of the right size. The size check is what makes a torn
 * write self-healing: a short file is not counted, so the part is re-sent.
 */
export async function listVerifiedParts(ctx: StoreContext, manifest: UploadManifest): Promise<number[]> {
  const entries = await ctx.storage.list(sessionKey(ctx.namespaceKey, manifest.uploadId));
  const tag = partTagFor(manifest.fingerprint);
  const verified: number[] = [];
  for (const entry of entries) {
    // Only parts carrying THIS upload's tag count. A correctly-sized part of
    // another file — an orphan — is invisible here (see layout.ts).
    const index = partIndexFromFileName(entry, tag);
    if (index === null || index > manifest.partCount) continue;
    const info = await ctx.storage.stat(partKey(ctx.namespaceKey, manifest.uploadId, index, tag));
    if (info && !info.isDirectory && info.size === expectedPartBytes(index, manifest.partBytes, manifest.totalBytes)) {
      verified.push(index);
    }
  }
  return verified;
}

export async function findSession(ctx: StoreContext, uploadId: string): Promise<UploadSession | null> {
  const manifest = await readManifest(ctx, uploadId);
  if (!manifest) return null;
  return summariseSession(manifest, await listVerifiedParts(ctx, manifest));
}

export async function readSession(ctx: StoreContext, uploadId: string): Promise<UploadSession> {
  const session = await findSession(ctx, uploadId);
  if (!session) throw new UploadError('NO_SESSION', `No upload in progress for "${uploadId}"`);
  return session;
}

/** Shape returned to clients for a session. Never exposes the namespace key. */
export function sessionView(session: UploadSession, maxFileBytes: number) {
  const { manifest } = session;
  return {
    uploadId: manifest.uploadId,
    fileName: manifest.fileName,
    totalBytes: manifest.totalBytes,
    partBytes: manifest.partBytes,
    partCount: manifest.partCount,
    receivedBytes: session.receivedBytes,
    missingParts: [...session.missingParts],
    complete: session.complete,
    createdAt: manifest.createdAt,
    maxFileBytes,
  };
}

export type SessionView = ReturnType<typeof sessionView>;
