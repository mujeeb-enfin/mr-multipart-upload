// ---------------------------------------------------------------------------
// slug.ts — the upload-id allowlist, and the name-based ids of 0.1.x
// ---------------------------------------------------------------------------
//
// SINCE 0.2.0 UPLOAD IDS ARE SHA-256 HASHES (server/namespace.ts uploadIdFor),
// so no file name reaches the filesystem. `assertSafeUploadId` is still the gate
// every id from a URL passes. `slugifyFileName` / `uploadIdForFileName` are kept
// exported for compatibility; they no longer name anything the server creates.
//
// What follows describes the 0.1.x scheme. An upload's parts lived in a
// directory named after the FILE NAME, so arbitrary human text reached the
// filesystem, and this module was the only thing between the two.
//
// TRANSFORM, then ALLOWLIST THE RESULT, then THROW. Real names such as
// `Café — Été №1.mp3`, `日本語のBGM.wav` and `Vol. 2 (Remastered).flac` are
// legitimate, so the raw name cannot be allowlisted directly. The transform's
// output is instead treated as untrusted input to a strict gate. `../../etc`
// slugifies to `etc`, and the allowlist admits no `/`, `\`, `.` or NUL, so
// traversal cannot survive it.
//
// The EXTENSION IS KEPT (`photo.jpg` -> `photo-jpg`), so `photo.jpg` and
// `photo.png` do not share a directory.
//
// NOT UNIQUE BY DESIGN. `Café.mp3`, `cafe.mp3` and `CAFE!!.mp3` all map to
// `cafe-mp3`. That is safe because the session manifest refuses to mix two
// different files (a 409 naming both), never because the slug is unique.
// ---------------------------------------------------------------------------

import { UploadError } from './errors.js';

/** Longest upload id produced or accepted. Keeps paths well inside PATH_MAX. */
export const MAX_UPLOAD_ID_LENGTH = 80;

/**
 * Names Windows reserves for devices. `mkdir con` fails with an opaque EINVAL,
 * which would take the whole upload down on a Windows dev machine.
 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * The single final allowlist.
 *
 * Lowercase only: on a case-insensitive filesystem (macOS, Windows) `Cafe` and
 * `cafe` are ONE directory, so permitting both would let two ids that compare
 * unequal in JavaScript resolve to the same path.
 */
const SAFE_UPLOAD_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Derive an upload id from a file name. May return '' — a name with no Latin
 * letters or digits has nothing to build one from. Does not throw, so it can be
 * used to preview; `assertSafeUploadId` is where '' is rejected.
 */
export function slugifyFileName(name: string): string {
  if (typeof name !== 'string') return '';

  const folded = name
    // NFKD splits accented characters into base + combining mark, so stripping
    // the marks leaves the base letter: `Café` -> `cafe`, not `caf`.
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  const hyphenated = folded
    // Every run outside the allowlist becomes ONE hyphen.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  // Truncation can expose a trailing hyphen that was interior before the cut.
  return hyphenated.slice(0, MAX_UPLOAD_ID_LENGTH).replace(/-+$/, '');
}

/** Reject anything that must never become a directory name. */
export function assertSafeUploadId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    // THE REJECT THAT MATTERS. A pure-CJK or emoji-only name slugifies to ''.
    // Left unchecked, every such upload would share one session directory.
    throw new UploadError(
      'INVALID_NAME',
      'The file name needs at least one Latin letter or digit, because the upload is ' +
        'tracked by name. Rename the file — for example "日本語のBGM (Japanese BGM).wav".',
    );
  }
  if (!SAFE_UPLOAD_ID.test(id)) {
    throw new UploadError(
      'INVALID_NAME',
      `Upload id "${id}" is not usable. It must start with a letter or digit and contain ` +
        `only lowercase letters, digits and hyphens, up to ${MAX_UPLOAD_ID_LENGTH} characters.`,
    );
  }
  if (RESERVED_NAMES.has(id)) {
    throw new UploadError('INVALID_NAME', `"${id}" is a reserved device name. Rename the file slightly.`);
  }
  // Unreachable while the allowlist forbids `.`; asserted anyway, because
  // "unreachable" quietly stops being true the moment someone relaxes a pattern.
  if (id === '.' || id === '..') {
    throw new UploadError('INVALID_NAME', 'Upload id must not be a relative path segment');
  }
}

/**
 * Slugify and validate in one step.
 * @deprecated Since 0.2.0 the server's upload ids are SHA-256 hashes, not slugs.
 */
export function uploadIdForFileName(name: string): string {
  const id = slugifyFileName(name);
  assertSafeUploadId(id);
  return id;
}
