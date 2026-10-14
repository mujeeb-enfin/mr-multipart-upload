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

export function namespaceKeyFor(namespace: string): string {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new UploadError('UNAUTHORIZED', 'authorize() must return a non-empty namespace');
  }
  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new UploadError('CONFIG_INVALID', `Namespace must be at most ${MAX_NAMESPACE_LENGTH} characters`);
  }
  return createHash('sha256').update(namespace, 'utf8').digest('hex').slice(0, 32);
}
