// ---------------------------------------------------------------------------
// fs-storage.ts — the filesystem backend
// ---------------------------------------------------------------------------
//
// `assemble` IS ONE PIPELINE, fed by a generator that walks the parts in order.
//
// The original ran one `pipeline(part, out, { end: false })` per part. That had
// two problems:
//
//   - `{ end: false }` was load-bearing: without it part 1 closed the file and
//     every later part was silently dropped — a 2 MB "400 MB" file and a
//     plausible success. One missing option away from data loss.
//   - Each pipeline left an `error` listener on the output stream, so a 200-part
//     upload stacked 200 listeners and Node logged MaxListenersExceededWarning.
//
// With a single pipeline the destination is ended exactly once, by the pipeline
// itself, after the last part — neither hazard exists.
//
// Still strictly sequential: one part is read at a time, so two file descriptors
// are in use whether there are 200 parts or 999,999. Never read parts
// concurrently: besides exhausting descriptors it would scramble the file.
//
// The hash is computed over the bytes as they flow to the DESTINATION, not in a
// separate pass over the parts, which could hash bytes that differ from what was
// written.
//
// `promote` uses rename, which REPLACES an existing destination on both Windows
// and POSIX — it does not throw EEXIST. That was verified by running it after a
// comment claimed otherwise. Dedupe therefore happens in the uploader, which
// checks for the destination before promoting.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AssemblyResult, StorageAdapter, StoredObjectInfo } from './adapter.js';
import { resolveUnderRoot } from './safe-path.js';

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

export class FsStorage implements StorageAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    return resolveUnderRoot(this.root, key);
  }

  localPath(key: string): string {
    return this.path(key);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const s = await stat(this.path(key));
      return { size: s.size, modifiedMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
      throw err;
    }
  }

  async list(dirKey: string): Promise<string[]> {
    try {
      return await readdir(this.path(dirKey));
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return [];
      throw err;
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as T;
    } catch (err) {
      if (isErrno(err, 'ENOENT') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async createExclusive(key: string, data: Uint8Array | string): Promise<'created' | 'exists'> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      // 'wx': the filesystem admits exactly one writer; the loser sees EEXIST.
      await writeFile(path, data, { flag: 'wx' });
      return 'created';
    } catch (err) {
      if (isErrno(err, 'EEXIST')) return 'exists';
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err;
    }
  }

  async removeTree(dirKey: string): Promise<void> {
    await rm(this.path(dirKey), { recursive: true, force: true });
  }

  async readHead(key: string, byteCount: number): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let total = 0;
    // `end` is INCLUSIVE in createReadStream.
    for await (const chunk of createReadStream(this.path(key), { start: 0, end: Math.max(0, byteCount - 1) })) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      total += buf.length;
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  }

  async assemble(partKeys: readonly string[], destKey: string): Promise<AssemblyResult> {
    const destPath = this.path(destKey);
    await mkdir(dirname(destPath), { recursive: true });
    // A stale staging file from a crashed attempt is removed, and the new one is
    // opened with 'wx' so it can never be appended to — which would produce a
    // file of the wrong length with a hash that matches nothing.
    await this.remove(destKey);

    const hash = createHash('sha256');
    let bytesWritten = 0;
    // Resolve every path up front, so a hostile key fails before any byte moves.
    const partPaths = partKeys.map((key) => this.path(key));

    async function* concatenated(): AsyncGenerator<Buffer> {
      for (const path of partPaths) {
        // One part at a time; the next is opened only after this one is drained.
        for await (const chunk of createReadStream(path)) {
          const buf = chunk as Buffer;
          hash.update(buf);
          bytesWritten += buf.length;
          yield buf;
        }
      }
    }

    try {
      await pipeline(concatenated(), createWriteStream(destPath, { flags: 'wx' }));
    } catch (err) {
      await this.remove(destKey);
      throw err;
    }

    return { bytesWritten, sha256: hash.digest('hex') };
  }

  async promote(fromKey: string, toKey: string): Promise<void> {
    const to = this.path(toKey);
    await mkdir(dirname(to), { recursive: true });
    await rename(this.path(fromKey), to);
  }

  openRead(key: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(createReadStream(this.path(key))) as ReadableStream<Uint8Array>;
  }
}
