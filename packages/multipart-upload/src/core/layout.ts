// ---------------------------------------------------------------------------
// layout.ts — where every file of an upload lives. Nothing here is random.
// ---------------------------------------------------------------------------
//
// Every name is DERIVED:
//
//   namespace directory   sha256 of the caller's namespace (see namespace.ts)
//   session directory     the file name, slugified (slug.ts)
//   part file             its 1-based index, zero padded
//   manifest / staging / lock   fixed names
//   final file            the sha256 of the assembled bytes
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
 * Digits in a part filename.
 *
 * Six, so names sort lexically in the same order as numerically — the property a
 * directory listing depends on. Three would break at 1000 parts (`1000.part`
 * sorts before `999.part`).
 */
export const PART_NUMBER_WIDTH = 6;

/** The most parts a single upload may have — the padding's capacity. */
export const MAX_PART_COUNT = 10 ** PART_NUMBER_WIDTH - 1;

/** Exactly a part filename: six digits, `.part`, nothing else. */
const PART_FILE_NAME = /^[0-9]{6}\.part$/;

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

/** Part filename for a 1-based index, zero padded so it sorts numerically. */
export function partFileName(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_PART_COUNT) {
    throw new UploadError('PART_OUT_OF_RANGE', `Part index ${index} is out of range`);
  }
  return `${String(index).padStart(PART_NUMBER_WIDTH, '0')}.part`;
}

export function partKey(namespaceKey: string, uploadId: string, index: number): string {
  return `${sessionKey(namespaceKey, uploadId)}/${partFileName(index)}`;
}

/**
 * The index a directory entry names, or null when it is not a part file.
 *
 * Anchored at BOTH ends, so nothing that merely starts or ends like a part file
 * is counted — the manifest, the staging file, the lock and any leftover are all
 * rejected here rather than needing a separate exclusion list kept in step.
 */
export function partIndexFromFileName(name: string): number | null {
  if (!PART_FILE_NAME.test(name)) return null;
  const index = Number(name.slice(0, PART_NUMBER_WIDTH));
  return index >= 1 ? index : null;
}
