// ---------------------------------------------------------------------------
// cloud-control.ts — a cloud upload's control files, and releasing a session
// ---------------------------------------------------------------------------
//
// The manifest, activity marker and head bytes of a cloud upload live in the
// backend's control store. This file writes them — never skipping a write
// quietly — proves whether an unrecorded object at the key is this upload's own
// commit, and releases everything a discarded or abandoned session holds at the
// provider. cloud-flow.ts runs the upload operations on top of it.
// ---------------------------------------------------------------------------

import { MANIFEST_FILE, activityKey, manifestKey, sessionKey } from '../core/layout.js';
import type { UploadManifest } from '../core/session.js';
import type { CloudBackend } from '../storage/cloud/types.js';
import { readManifest, type StoreContext } from './store.js';

export function backendOf(store: StoreContext): CloudBackend {
  if (!store.backend) throw new Error('cloud operation on a store without a cloud backend');
  return store.backend;
}

/** The manifest without its commit marker. */
export function withoutMarker(manifest: UploadManifest): UploadManifest {
  const copy: { -readonly [K in keyof UploadManifest]: UploadManifest[K] } = { ...manifest };
  delete copy.commitStartedAt;
  return copy;
}

/**
 * Replace a control file. Never skipped quietly: a manifest write that did not
 * happen loses a commit marker or a `committed` record — an upload's file then
 * passes for someone else's, or is never recorded at all.
 */
export async function writeControl(storage: StoreContext['storage'], key: string, data: Uint8Array | string): Promise<void> {
  if (!storage.write) throw new Error('A cloud control store must implement write().');
  await storage.write(key, data);
}

export async function writeManifest(store: StoreContext, manifest: UploadManifest): Promise<void> {
  await writeControl(store.storage, manifestKey(store.namespaceKey, manifest.uploadId), JSON.stringify(manifest, null, 2));
}

export async function touch(store: StoreContext, uploadId: string): Promise<void> {
  await writeControl(store.storage, activityKey(store.namespaceKey, uploadId), new Date().toISOString());
}

/**
 * The object THIS upload's commit left at its key, when the commit's outcome
 * was never recorded: a commit was started (`commitStartedAt`), the provider
 * holds no parts any more, and an object exists. Without the marker an object
 * there is not this upload's — a custom `destination()` gave another upload
 * the same key — and must be neither claimed nor deleted.
 */
export async function ownCommittedObject(backend: CloudBackend, manifest: UploadManifest): Promise<{ key: string; size: number } | null> {
  if (!manifest.commitStartedAt || !manifest.cloud) return null;
  // Proved from the provider (holdsOwnCommit), not guessed from "our parts are
  // gone and something is there": on Azure another upload's commit onto a
  // shared blob also makes our uncommitted blocks disappear.
  if (!(await backend.holdsOwnCommit(manifest.cloud).catch(() => false))) return null;
  const info = await backend.control.stat(manifest.cloud.key).catch(() => null);
  return info && !info.isDirectory ? { key: manifest.cloud.key, size: info.size } : null;
}

/**
 * Release everything an abandoned session holds at the provider: the committed
 * file, a file whose commit was never recorded (any size — the marker proves it
 * is this upload's), or the open multipart session.
 */
async function releaseCloudSession(backend: CloudBackend, manifest: UploadManifest | null, manifestAt: string): Promise<void> {
  if (manifest?.committed) {
    await backend.deleteObject(manifest.committed.key);
  } else if (manifest?.cloud) {
    // Only an object proved to be this session's own commit goes — for a staged
    // session (Azure direct), a finished copy this session made.
    const orphan = await ownCommittedObject(backend, manifest);
    if (orphan) await backend.deleteObject(manifest.cloud.key);
    // The marker goes BEFORE the abort. An aborted S3 upload lists no parts,
    // exactly like a completed one; a marker that outlived the abort (a crash,
    // a failed manifest delete) would let another upload's object at a shared
    // key pass for this one's commit — to be claimed, or deleted.
    if (manifest.commitStartedAt) await writeControl(backend.control, manifestAt, JSON.stringify(withoutMarker(manifest), null, 2));
    await backend.abortSession(manifest.cloud);
  }
  // The manifest next, before the rest of the session's files: while it says
  // `committed`, a retried complete would report a file just deleted as done.
  await backend.control.remove(manifestAt);
}

export async function discardCloudUpload(store: StoreContext, uploadId: string): Promise<void> {
  const at = manifestKey(store.namespaceKey, uploadId);
  await releaseCloudSession(backendOf(store), await readManifest(store, uploadId), at);
  await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId));
}

/** For the sweep: release the provider side of a stale session before its files go. */
export function cloudSweepRelease(backend: CloudBackend) {
  return async (dirKey: string) => {
    const at = `${dirKey}/${MANIFEST_FILE}`;
    await releaseCloudSession(backend, await backend.control.readJson<UploadManifest>(at), at);
  };
}
