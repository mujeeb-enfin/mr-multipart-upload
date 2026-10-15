// ---------------------------------------------------------------------------
// namespace.ts — isolate one user's uploads from another's
// ---------------------------------------------------------------------------
//
// NEW IN THE PUBLIC LIBRARY, and required for it. The original kept sessions by
// file name alone, which was safe only because a single administrator uploaded.
// With many users, two people uploading `photo.jpg` would land in one directory.
//
// The namespace comes from the application's `authorize` hook — typically a user
// id. It is HASHED to form the directory name rather than slugified:
//
//   - Slugifying is lossy. `User_42` and `user-42` would both become `user-42`,
//     merging two different users. A hash keeps distinct inputs distinct.
//   - Case-insensitive filesystems fold `UserA` and `usera` into one directory;
//     lowercase hex cannot collide that way.
//   - A hash contains no `/`, `.` or NUL, so a hostile namespace cannot traverse.
//
// Still derived, never random: the same namespace always maps to the same
// directory, which is what lets a user resume after a restart.
//
// 128 bits of SHA-256 (32 hex characters) keeps paths short; an accidental
// collision needs on the order of 2^64 namespaces.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { UploadError } from '../core/errors.js';

/** The namespace used when an application opts in to anonymous uploads. */
export const ANONYMOUS_NAMESPACE = '__anonymous__';

const MAX_NAMESPACE_LENGTH = 512;

/**
 * The tag that binds a part file to the file it belongs to (see layout.ts).
 * 64 bits of SHA-256 over the fingerprint: derived, so the same file always gets
 * the same tag and resumes, while a different file never shares one.
 */
export function partTagFor(fingerprint: string): string {
  return createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 16);
}

/** What identifies one upload. Every field is bound into its id. */
export interface UploadIdentity {
  readonly fileName: string;
  readonly totalBytes: number;
  /** The declared MIME type (see file-types.ts `declaredTypeFor`). */
  readonly contentType: string;
  /** The client's content fingerprint: size, mtime, name and sampled bytes. */
  readonly fingerprint: string;
}

/**
 * The upload id, which is also the name of its temporary folder:
 * `.parts/<namespace key>/<upload id>/`. The full SHA-256 (64 hex characters)
 * of the file name, size, MIME type and content fingerprint.
 *
 * Derived, never random, so the same file resumes into the same folder after a
 * reload or a restart. A file differing in ANY of those — even only its
 * declared type — gets a different folder, so its parts can never merge with
 * another file's. The file name does not appear in the folder name.
 *
 * Encoded as a JSON array so field boundaries are unambiguous: ("a", "bc") and
 * ("ab", "c") cannot produce the same input.
 */
export function uploadIdFor(identity: UploadIdentity): string {
  const encoded = JSON.stringify([
    'mpu-upload-v2',
    identity.fileName,
    identity.totalBytes,
    identity.contentType,
    identity.fingerprint,
  ]);
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

export function namespaceKeyFor(namespace: string): string {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new UploadError('UNAUTHORIZED', 'authorize() must return a non-empty namespace');
  }
  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new UploadError('CONFIG_INVALID', `Namespace must be at most ${MAX_NAMESPACE_LENGTH} characters`);
  }
  return createHash('sha256').update(namespace, 'utf8').digest('hex').slice(0, 32);
}
