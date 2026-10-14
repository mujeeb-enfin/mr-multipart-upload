// ---------------------------------------------------------------------------
// fingerprint.ts — a stable identifier for a file, derived, never random
// ---------------------------------------------------------------------------
//
// It lets the server tell "the same file again" (resume) from "a different file
// with the same name" (refuse with 409).
//
// DERIVED, NOT STORED. An earlier design generated a random id and kept it in
// sessionStorage, which breaks the case resume exists for: sessionStorage is
// per-tab and cleared when the tab closes, so re-picking the same file after a
// reload produced a NEW id, mismatched the manifest, and got a 409 instead of
// resuming. Size + lastModified + name needs no storage and survives a tab
// close, a browser restart and a different machine.
//
// NOT CRYPTOGRAPHIC, deliberately. `crypto.subtle` requires a secure context,
// which would add an HTTPS-only failure mode on local development for what is a
// mismatch detector, not a secret. Size and mtime do the discriminating work.
// ---------------------------------------------------------------------------

export interface FingerprintSource {
  readonly name: string;
  readonly size: number;
  readonly lastModified?: number;
}

export function fingerprintFor(file: FingerprintSource): string {
  let hash = 5381;
  for (let i = 0; i < file.name.length; i += 1) {
    hash = ((hash << 5) + hash + file.name.charCodeAt(i)) | 0;
  }
  return `${file.size}-${file.lastModified ?? 0}-${(hash >>> 0).toString(36)}`;
}
