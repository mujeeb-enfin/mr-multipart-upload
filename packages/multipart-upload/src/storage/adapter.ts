// ---------------------------------------------------------------------------
// adapter.ts — what a storage backend must provide
// ---------------------------------------------------------------------------
//
// EXPERIMENTAL until a second backend exists. An interface designed against one
// implementation usually needs revising when the second arrives; it may change in
// a minor version before 1.0.
//
// The methods are shaped around the SEMANTICS correctness depends on, not around
// filesystem calls, so a cloud backend can satisfy them natively:
//
//   createExclusive   must fail (return 'exists') if the key is present. This is
//                     the concurrency control for parts, manifests and the lock.
//                     On the filesystem: flag 'wx'. On S3: If-None-Match: *.
//   assemble          one call, so the filesystem can stream parts into a file
//                     while S3 could use native multipart completion.
//
// Keys are always relative, `/`-separated and produced by layout.ts; an adapter
// must still refuse to resolve one outside its root.
// ---------------------------------------------------------------------------

export interface StoredObjectInfo {
  readonly size: number;
  readonly modifiedMs: number;
  readonly isDirectory: boolean;
}

export interface AssemblyResult {
  readonly bytesWritten: number;
  /** Lowercase hex SHA-256 of the bytes actually written to the destination. */
  readonly sha256: string;
}

export interface StorageAdapter {
  /** Size and age of a key, or null when it does not exist. */
  stat(key: string): Promise<StoredObjectInfo | null>;

  /** Names directly under a directory key. Empty when it does not exist. */
  list(dirKey: string): Promise<string[]>;

  /** Parsed JSON, or null when absent or unparseable. */
  readJson<T>(key: string): Promise<T | null>;

  /**
   * Create `key` only if it does not exist. Exactly one of several concurrent
   * callers may get 'created'. Creates parent directories as needed.
   */
  createExclusive(key: string, data: Uint8Array | string): Promise<'created' | 'exists'>;

  /**
   * Create or REPLACE `key`. Optional: used by the cloud backends for files that
   * change during an upload (the activity marker, the manifest once committed).
   */
  write?(key: string, data: Uint8Array | string): Promise<void>;

  /** Delete one key. Absent is success. */
  remove(key: string): Promise<void>;

  /** Delete a directory key and everything under it. Absent is success. */
  removeTree(dirKey: string): Promise<void>;

  /** The first `byteCount` bytes of a key (fewer if it is shorter). */
  readHead(key: string, byteCount: number): Promise<Uint8Array>;

  /**
   * Concatenate `partKeys`, in order, into `destKey`, hashing the bytes as they
   * are written. Must not buffer the whole result in memory.
   */
  assemble(partKeys: readonly string[], destKey: string): Promise<AssemblyResult>;

  /** Move `fromKey` to `toKey`, creating parents. Replaces an existing `toKey`. */
  promote(fromKey: string, toKey: string): Promise<void>;

  /**
   * Move `fromKey` to `toKey` only if `toKey` does not exist — one atomic step,
   * so two concurrent moves onto one key cannot both succeed. 'exists' leaves
   * `fromKey` in place. Optional: without it a stat, then `promote`, is used.
   */
  promoteExclusive?(fromKey: string, toKey: string): Promise<'moved' | 'exists'>;

  /** Stream a key's contents. */
  openRead(key: string): ReadableStream<Uint8Array>;

  /** Absolute local path for a key, when the backend has one. */
  localPath?(key: string): string;
}
