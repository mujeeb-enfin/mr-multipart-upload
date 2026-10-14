// ---------------------------------------------------------------------------
// storage.test.ts — path containment and the filesystem backend
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. (1) No storage key can escape the root. (2) Assembly
// concatenates every part, in order, and hashes exactly the bytes written. The
// assembly bugs are silent: dropping `{ end: false }` yields a short file, and
// reordering yields a correctly-sized wrong one — so parts with DISTINCT,
// offset-dependent bytes are used and the result is compared byte for byte.
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsStorage } from '../src/storage/fs-storage.js';
import { StoragePathError, resolveUnderRoot } from '../src/storage/safe-path.js';
import { patternBytes, sha256, tempRoot } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: root, cleanup } = await tempRoot());
});
afterEach(() => cleanup());

describe('resolveUnderRoot', () => {
  it('resolves a normal key inside the root', () => {
    expect(relative(root, resolveUnderRoot(root, '.parts/a/b.part')).replace(/\\/g, '/')).toBe('.parts/a/b.part');
  });

  it('REFUSES every escape', () => {
    for (const key of ['../x', 'a/../../x', '..\\..\\x', '/etc/passwd', '\\x', 'C:/x', 'c:x', 'a\0b', '']) {
      expect(() => resolveUnderRoot(root, key), JSON.stringify(key)).toThrow(StoragePathError);
    }
  });

  it('works with a RELATIVE root — the bug fixed in the port', () => {
    // MUTATION: compare against the root as passed -> './uploads' never
    // prefixes an absolute path and every key is refused.
    expect(() => resolveUnderRoot('./relative-root', 'files/x.bin')).not.toThrow();
  });

  it('does not accept a sibling directory that shares the prefix', () => {
    // The `root + sep` check: `<root>-evil` must not pass startsWith(root).
    expect(() => resolveUnderRoot(join(root, 'up'), '../up-evil/x')).toThrow(StoragePathError);
  });
});

describe('FsStorage.createExclusive', () => {
  it('admits exactly one writer', async () => {
    const storage = new FsStorage(root);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => storage.createExclusive('s/000001.part', patternBytes(1024, i + 1))),
    );
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'exists')).toHaveLength(7);
  });
});

describe('FsStorage.assemble', () => {
  async function writeParts(storage: FsStorage, sizes: number[]) {
    const parts = sizes.map((size, i) => patternBytes(size, i + 11));
    for (const [i, bytes] of parts.entries()) await storage.createExclusive(`s/${i + 1}.part`, bytes);
    const whole = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
    let offset = 0;
    for (const bytes of parts) {
      whole.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return { keys: parts.map((_, i) => `s/${i + 1}.part`), whole };
  }

  it('concatenates every part in order and hashes the written bytes', async () => {
    // MUTATION: stop after the first part, or reverse the part order -> the
    // size or the hash differs. Unequal sizes and distinct, offset-dependent
    // bytes make a dropped, repeated or reordered part visible.
    const storage = new FsStorage(root);
    const { keys, whole } = await writeParts(storage, [70_000, 70_000, 70_000, 12_345]);
    const result = await storage.assemble(keys, 's/assembled.bin');

    const onDisk = new Uint8Array(await readFile(join(root, 's/assembled.bin')));
    expect(result.bytesWritten).toBe(whole.byteLength);
    expect(onDisk.byteLength).toBe(whole.byteLength);
    expect(sha256(onDisk)).toBe(sha256(whole));
    expect(result.sha256).toBe(sha256(whole));
  }, 10_000);

  it('assembles many parts without stacking listeners on the output stream', async () => {
    // The original's per-part pipeline left one `error` listener per part on the
    // output stream; 11+ parts triggered MaxListenersExceededWarning.
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const storage = new FsStorage(root);
      const { keys, whole } = await writeParts(storage, Array.from({ length: 40 }, () => 1000));
      const result = await storage.assemble(keys, 's/many.bin');
      expect(result.sha256).toBe(sha256(whole));
      await new Promise((r) => setImmediate(r)); // warnings are emitted asynchronously
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('replaces a stale staging file instead of appending to it', async () => {
    const storage = new FsStorage(root);
    const { keys, whole } = await writeParts(storage, [5000, 5000]);
    await writeFile(join(root, 's/assembled.bin'), patternBytes(99_999, 3));
    const result = await storage.assemble(keys, 's/assembled.bin');
    expect(result.bytesWritten).toBe(whole.byteLength);
    expect((await readFile(join(root, 's/assembled.bin'))).byteLength).toBe(whole.byteLength);
  });

  it('removes the partial output when a part is missing', async () => {
    const storage = new FsStorage(root);
    const { keys } = await writeParts(storage, [5000]);
    await expect(storage.assemble([...keys, 's/missing.part'], 's/assembled.bin')).rejects.toThrow();
    expect(await storage.stat('s/assembled.bin')).toBeNull();
  });
});

describe('FsStorage.promote', () => {
  it('REPLACES an existing destination rather than throwing — dedupe must not rely on it', async () => {
    // Pins the behaviour a source comment once got wrong. If rename ever starts
    // throwing EEXIST, the uploader's explicit existence check is still correct.
    const storage = new FsStorage(root);
    await storage.createExclusive('a.bin', 'new');
    await storage.createExclusive('files/b.bin', 'old');
    await storage.promote('a.bin', 'files/b.bin');
    expect(await readFile(join(root, 'files/b.bin'), 'utf8')).toBe('new');
  });
});
