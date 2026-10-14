// ---------------------------------------------------------------------------
// safe-path.ts — the single containment check for every storage key
// ---------------------------------------------------------------------------
//
// THE FOUR CHECKS, and why none is redundant:
//
//   - NUL byte: Node throws on its own, but with a message that does not say the
//     key was hostile.
//   - `..` segment, split on BOTH separators: catches a Windows-style `..\..` on
//     POSIX, where `path.resolve` treats the backslash as an ordinary character
//     and the traversal would survive into the final path.
//   - absolute / drive-letter: `resolve(root, '/etc/passwd')` returns
//     `/etc/passwd` — the root is simply discarded — so this is refused before
//     resolving rather than detected after.
//   - resolved prefix: the backstop that still holds if the three above are ever
//     relaxed. `root + sep` is load-bearing: without the separator a sibling
//     directory named `uploads-evil` passes a bare `startsWith(root)`.
//
// FIXED IN THE PORT. The original compared the resolved path against the root
// AS PASSED. With an absolute root that is fine; with a relative one such as the
// default `./uploads`, `resolve()` returns an absolute path that can never start
// with `./uploads/` — so every key would have been rejected. The root is now
// resolved first.
// ---------------------------------------------------------------------------

import { resolve, sep } from 'node:path';

export class StoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoragePathError';
  }
}

/** Resolve `key` inside `root`, refusing anything that escapes. */
export function resolveUnderRoot(root: string, key: string): string {
  if (!key || typeof key !== 'string') throw new StoragePathError('Storage key is required');
  if (key.includes('\0')) throw new StoragePathError('Storage key contains a NUL byte');

  const segments = key.split(/[/\\]+/);
  if (segments.some((s) => s === '..')) {
    throw new StoragePathError('Storage key must not contain a parent segment');
  }
  if (key.startsWith('/') || key.startsWith('\\') || /^[A-Za-z]:/.test(key)) {
    throw new StoragePathError('Storage key must be relative');
  }

  const base = resolve(root);
  const full = resolve(base, key);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new StoragePathError('Storage key escapes the storage directory');
  }
  return full;
}
