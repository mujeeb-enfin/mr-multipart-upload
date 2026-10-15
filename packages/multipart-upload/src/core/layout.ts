// ---------------------------------------------------------------------------
// layout.ts — where every file of an upload lives. Nothing here is random.
// ---------------------------------------------------------------------------
//
// Every name is DERIVED:
//
//   namespace directory   sha256 of the caller's namespace (see namespace.ts)
//   session directory     the upload id: sha256 of the file name, size, MIME
//                         type and fingerprint (server/namespace.ts uploadIdFor)
//   part file             its 1-based index, zero padded, plus the PART TAG
//   manifest / staging / lock   fixed names
//   final file            the sha256 of the assembled bytes
//
// THE PART TAG binds every part to the file it belongs to: 16 hex characters
// derived from the upload's fingerprint, e.g. `000002.3f9a1c07b2d4e816.part`.
// Without it a part file's SIZE was the only evidence of its identity, and that
// was not enough. A part write that was already in flight when its upload was
// discarded could land afterwards, leaving an orphan. When session directories
// were named after the file (before 0.2.0), a DIFFERENT file uploaded later
// under the same name then found a correctly-sized `000002.part`, treated it as
// already received, and assembled the old file's bytes into the new one —
// reported as a success. Since 0.2.0 that second file has its own directory (the
// id hashes the fingerprint too); the tag remains as a second line of defence,
// so any stray part is never counted, never reused, and `complete` deletes it.
//
// That is a constraint, not an aesthetic. A random component anywhere in a
// resumable upload has to be PERSISTED to be useful on the next attempt, and
// whatever persists it becomes a second source of truth that can disagree with
// the disk. Deriving every name means the only state is the files themselves:
// listing the directory IS the resume computation, and it survives a tab close,
// a browser restart and a server restart.
//
// This module never touches a filesystem, so it is testable without one.
// ---------------------------------------------------------------------------

import { UploadError } from './errors.js';

/** Directory, inside the storage root, that holds in-progress uploads. */
export const PARTS_DIR = '.parts';

/** Directory, inside the storage root, that holds completed files by default. */
export const FILES_DIR = 'files';

/** Fixed name of the manifest inside a session directory. */
export const MANIFEST_FILE = 'manifest.json';

/**
 * Fixed name the assembled file is written to before it is promoted to its
 * content-addressed key. Inside the session directory, so it is reclaimed by the
 * same sweep if a `complete` dies part-way.
 */
export const STAGING_FILE = 'assembled.bin';

/** Fixed name of the single-flight lock held while a `complete` runs. */
export const LOCK_FILE = 'completing.lock';

/**
 * Cloud backends only: the file's first bytes, kept when part 1 arrives through
 * the server. S3 and Azure cannot read parts before they are committed, so this
 * is what lets the content check run BEFORE the file exists.
 */
export const HEAD_FILE = 'head.bin';

/**
 * Cloud backends only: rewritten on every part. Parts live inside the
 * provider's multipart session, not as files here, and Azure's Put Block does
 * not even update the blob's last-modified time — so this is what the sweep
 * measures an upload's age by.
 */
export const ACTIVITY_FILE = 'activity';

/**
 * Digits in a part filename.
 *
 * Six, so names sort lexically in the same order as numerically — the property a
 * directory listing depends on. Three would break at 1000 parts (`1000.part`
 * sorts before `999.part`).
 */
export const PART_NUMBER_WIDTH = 6;

/** The most parts a single upload may have — the padding's capacity. */
export const MAX_PART_COUNT = 10 ** PART_NUMBER_WIDTH - 1;

/** A part tag: 16 lowercase hex characters, derived from the fingerprint. */
const PART_TAG = /^[0-9a-f]{16}$/;

/** Exactly a part filename: six digits, a tag, `.part`, nothing else. */
const PART_FILE_NAME = /^([0-9]{6})\.([0-9a-f]{16})\.part$/;

/** Directory holding every session of one namespace. */
export function namespaceDirKey(namespaceKey: string): string {
  return `${PARTS_DIR}/${namespaceKey}`;
}

/** Session directory key, relative to the storage root. */
export function sessionKey(namespaceKey: string, uploadId: string): string {
  return `${namespaceDirKey(namespaceKey)}/${uploadId}`;
}

export function manifestKey(namespaceKey: string, uploadId: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${MANIFEST_FILE}`;
}

export function stagingKey(namespaceKey: string, uploadId: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${STAGING_FILE}`;
}

export function lockKey(namespaceKey: string, uploadId: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${LOCK_FILE}`;
}

export function headKey(namespaceKey: string, uploadId: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${HEAD_FILE}`;
}

export function activityKey(namespaceKey: string, uploadId: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${ACTIVITY_FILE}`;
}

/**
 * Part filename for a 1-based index and the upload's part tag. The index is
 * zero padded so names sort numerically.
 */
export function partFileName(index: number, tag: string): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_PART_COUNT) {
    throw new UploadError('PART_OUT_OF_RANGE', `Part index ${index} is out of range`);
  }
  if (!PART_TAG.test(tag)) {
    throw new UploadError('CONFIG_INVALID', `Part tag "${tag}" must be 16 lowercase hex characters`);
  }
  return `${String(index).padStart(PART_NUMBER_WIDTH, '0')}.${tag}.part`;
}

export function partKey(namespaceKey: string, uploadId: string, index: number, tag: string): string {
  return `${sessionKey(namespaceKey, uploadId)}/${partFileName(index, tag)}`;
}

/**
 * The index and tag a directory entry names, or null when it is not a part file.
 *
 * Anchored at BOTH ends, so nothing that merely resembles a part file is
 * accepted — the manifest, the staging file, the lock and any leftover are all
 * rejected here rather than needing a separate exclusion list kept in step.
 */
export function parsePartFileName(name: string): { index: number; tag: string } | null {
  const match = PART_FILE_NAME.exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 1 ? { index, tag: match[2] as string } : null;
}

/**
 * The index a directory entry names IF it belongs to the upload with `tag`,
 * otherwise null. A part of another file — an orphan — is never counted.
 */
export function partIndexFromFileName(name: string, tag: string): number | null {
  const parsed = parsePartFileName(name);
  return parsed && parsed.tag === tag ? parsed.index : null;
}
