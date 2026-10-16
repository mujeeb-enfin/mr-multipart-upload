// ---------------------------------------------------------------------------
// cloud/s3-backend.ts — Amazon S3 and S3-compatible stores (MinIO)
// ---------------------------------------------------------------------------
//
// PARTS use S3's native multipart upload with ChecksumAlgorithm SHA256: S3
// verifies every part against the SHA-256 sent with it (BadDigest otherwise),
// keeps it, and reports it in ListParts — which is where the composite checksum
// comes from. The bytes are never downloaded or re-uploaded to assemble them.
//
// DIRECT TRANSFER signs `x-amz-checksum-sha256` AND `content-length` into the
// presigned URL: the browser cannot send other bytes, another checksum or
// another length without the signature failing. (Verified against an S3
// implementation: tampered bytes → BadDigest; changed header or length →
// SignatureDoesNotMatch.)
//
// The SDK is told to add checksums only WHEN REQUIRED. Its newer default adds
// a CRC32 to every request, which would sign a checksum of the server's request
// into presigned URLs the browser then cannot satisfy.
// ---------------------------------------------------------------------------

import type * as S3Sdk from '@aws-sdk/client-s3';
import type * as S3Presigner from '@aws-sdk/s3-request-presigner';

import type { CloudSessionRef } from '../../core/session.js';
import type { StorageAdapter, StoredObjectInfo } from '../adapter.js';
import { base64ToHex, compositeSha256, hexToBase64 } from './checksums.js';
import { loadOptional } from './load-optional.js';
import type { CloudBackend, CloudCommitResult, CloudPart, DirectPartRequest } from './types.js';

export interface S3BackendConfig {
  readonly kind: 'aws_s3' | 'minio';
  readonly bucket: string;
  readonly region: string;
  /** '' or ends with '/'. */
  readonly prefix: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  /** Omitted: the AWS SDK's default chain (env, profile, SSO, instance/task role, IRSA). */
  readonly credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

type Sdk = typeof S3Sdk;

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchUpload' || statusOf(err) === 404;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/** A lazily-started web stream over an object, so `openRead` can stay synchronous. */
function lazyStream(open: () => Promise<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= (await open()).getReader();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

/** Control files as S3 objects. Keys are the library's layout keys under `prefix`. */
class S3ControlStore implements StorageAdapter {
  constructor(
    private readonly sdk: Sdk,
    private readonly client: S3Sdk.S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
  ) {}

  private full(key: string): string {
    return `${this.prefix}${key}`;
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const head = await this.client.send(new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return { size: head.ContentLength ?? 0, modifiedMs: head.LastModified?.getTime() ?? 0, isDirectory: false };
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    // S3 has no directories: a "directory" exists while any key lies under it.
    const under = await this.client.send(
      new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${this.full(key)}/`, MaxKeys: 1 }),
    );
    const first = under.Contents?.[0];
    return first ? { size: 0, modifiedMs: first.LastModified?.getTime() ?? 0, isDirectory: true } : null;
  }

  async list(dirKey: string): Promise<string[]> {
    const prefix = `${this.full(dirKey)}/`;
    const names: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }),
      );
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) names.push(p.Prefix.slice(prefix.length, -1));
      for (const o of page.Contents ?? []) if (o.Key && o.Key !== prefix) names.push(o.Key.slice(prefix.length));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return names;
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return JSON.parse(await (res.Body as { transformToString(): Promise<string> }).transformToString()) as T;
    } catch (err) {
      if (isNotFound(err) || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async createExclusive(key: string, data: Uint8Array | string, conflictRetried = false): Promise<'created' | 'exists'> {
    try {
      // Conditional write: S3 refuses with 412 if the key exists, atomically.
      await this.client.send(
        new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.full(key), Body: toBytes(data), IfNoneMatch: '*' }),
      );
      return 'created';
    } catch (err) {
      if (statusOf(err) === 412) return 'exists';
      // 409 ConditionalRequestConflict: a concurrent write or DELETE of the key
      // was in flight, so the key may well NOT exist (a lock being released).
      // Asked once more; a second conflict means another writer is active now.
      if (statusOf(err) === 409) return conflictRetried ? 'exists' : this.createExclusive(key, data, true);
      throw err;
    }
  }

  async write(key: string, data: Uint8Array | string): Promise<void> {
    await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.full(key), Body: toBytes(data) }));
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async removeTree(dirKey: string): Promise<void> {
    const prefix = `${this.full(dirKey)}/`;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      // One request per key rather than DeleteObjects: session directories hold
      // a handful of control files, and DeleteObjects is not implemented by
      // every S3-compatible store.
      for (const o of page.Contents ?? []) {
        if (o.Key) await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: o.Key }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async readHead(key: string, byteCount: number): Promise<Uint8Array> {
    if (byteCount <= 0) return new Uint8Array(0);
    try {
      const res = await this.client.send(
        new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.full(key), Range: `bytes=0-${byteCount - 1}` }),
      );
      return await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    } catch (err) {
      if (statusOf(err) === 416) return new Uint8Array(0); // empty object
      throw err;
    }
  }

  async assemble(): Promise<never> {
    throw new Error('S3 control store does not assemble files; parts use S3 multipart upload.');
  }

  async promote(): Promise<never> {
    throw new Error('S3 control store does not move files.');
  }

  openRead(key: string): ReadableStream<Uint8Array> {
    return lazyStream(async () => {
      const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return (res.Body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
    });
  }
}

export async function createS3Backend(config: S3BackendConfig): Promise<CloudBackend> {
  const label = `storage "${config.kind}"`;
  const sdk = await loadOptional<Sdk>('@aws-sdk/client-s3', label);
  const client = new sdk.S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    // A copy: the SDK writes into the credentials object it is given, and the
    // configuration it came from is a cache key (see cloud-backends.ts).
    ...(config.credentials ? { credentials: { ...config.credentials } } : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const control = new S3ControlStore(sdk, client, config.bucket, config.prefix);
  const Bucket = config.bucket;
  const full = (key: string) => `${config.prefix}${key}`;
  let presigner: typeof S3Presigner | undefined;

  function uploadIdOf(session: CloudSessionRef): string {
    if (!session.uploadId) throw new Error('S3 session without an UploadId');
    return session.uploadId;
  }

  async function listParts(session: CloudSessionRef): Promise<CloudPart[]> {
    const parts: CloudPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await client.send(
          new sdk.ListPartsCommand({ Bucket, Key: full(session.key), UploadId: uploadIdOf(session), PartNumberMarker: marker }),
        );
        for (const p of page.Parts ?? []) {
          if (p.PartNumber === undefined) continue;
          parts.push({
            index: p.PartNumber,
            size: p.Size ?? 0,
            sha256: p.ChecksumSHA256 ? base64ToHex(p.ChecksumSHA256) : undefined,
            ...(p.ETag ? { etag: p.ETag } : {}),
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      // The session was aborted or completed: it holds no parts.
      if (isNotFound(err)) return [];
      throw err;
    }
    return parts;
  }

  return {
    kind: config.kind,
    control,
    directChecksums: ['sha256'],
    supportsDirect: true,

    async createSession(key, contentType) {
      const created = await client.send(
        new sdk.CreateMultipartUploadCommand({ Bucket, Key: full(key), ContentType: contentType, ChecksumAlgorithm: 'SHA256' }),
      );
      if (!created.UploadId) throw new Error('S3 did not return an UploadId');
      return { kind: config.kind, key, uploadId: created.UploadId };
    },

    async abortSession(session) {
      try {
        await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key: full(session.key), UploadId: uploadIdOf(session) }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async putPart(session, index, bytes, sha256) {
      await client.send(
        new sdk.UploadPartCommand({
          Bucket,
          Key: full(session.key),
          UploadId: uploadIdOf(session),
          PartNumber: index,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ChecksumSHA256: hexToBase64(sha256),
        }),
      );
    },

    async presignPart(session, index, length, sha256, _md5, ttlSeconds): Promise<DirectPartRequest> {
      presigner ??= await loadOptional<typeof S3Presigner>('@aws-sdk/s3-request-presigner', `${label} with transfer "direct"`);
      const checksum = hexToBase64(sha256);
      const command = new sdk.UploadPartCommand({
        Bucket,
        Key: full(session.key),
        UploadId: uploadIdOf(session),
        PartNumber: index,
        ContentLength: length,
        ChecksumSHA256: checksum,
      });
      const url = await presigner.getSignedUrl(client, command, {
        expiresIn: ttlSeconds,
        // Kept as signed HEADERS (not hoisted into the query string), so S3
        // checks the bytes against them and the browser cannot change them.
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        signableHeaders: new Set(['content-length']),
      });
      return {
        url,
        method: 'PUT',
        headers: { 'x-amz-checksum-sha256': checksum },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },

    listParts,

    async commit(session, parts, _contentType): Promise<CloudCommitResult> {
      const ordered = [...parts].sort((a, b) => a.index - b.index);
      await client.send(
        new sdk.CompleteMultipartUploadCommand({
          Bucket,
          Key: full(session.key),
          UploadId: uploadIdOf(session),
          MultipartUpload: {
            Parts: ordered.map((p) => ({
              PartNumber: p.index,
              ETag: p.etag,
              ...(p.sha256 ? { ChecksumSHA256: hexToBase64(p.sha256) } : {}),
            })),
          },
        }),
      );
      return {
        key: session.key,
        size: ordered.reduce((sum, p) => sum + p.size, 0),
        checksum: compositeSha256(ordered.map((p) => p.sha256)),
      };
    },

    readObjectHead: (key, byteCount) => control.readHead(key, byteCount),
    deleteObject: (key) => control.remove(key),
    openRead: (key) => control.openRead(key),
  };
}
