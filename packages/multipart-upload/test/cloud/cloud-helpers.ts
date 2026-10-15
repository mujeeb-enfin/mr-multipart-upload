// ---------------------------------------------------------------------------
// cloud-helpers.ts — run the same scenarios against every configured backend
// ---------------------------------------------------------------------------
//
// Backends are real S3 / Azure implementations, not mocks. Each kind runs only
// when its endpoint is configured (skipped, and reported as skipped, otherwise):
//
//   MPU_TEST_S3_ENDPOINT, MPU_TEST_S3_ACCESS_KEY, MPU_TEST_S3_SECRET_KEY
//       → aws_s3 and minio (both are S3 protocol; minio exercises its own config path)
//   MPU_TEST_AZURE_CONNECTION_STRING
//       → azure_blob
//
// Locally these point at VersityGW (an S3 gateway that enforces SigV4 and
// checksums) and Azurite (Microsoft's emulator). Each test file gets its own
// bucket / container, removed afterwards.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { cloudBackendFor } from '../../src/server/cloud-backends.js';
import { resolveConfig } from '../../src/server/config.js';
import { resolveStorage, type StorageKind, type StorageOverrides } from '../../src/server/storage-config.js';
import type { CloudBackend } from '../../src/storage/cloud/types.js';

export type CloudKind = Exclude<StorageKind, 'local'>;

const s3Endpoint = process.env.MPU_TEST_S3_ENDPOINT;
const s3Key = process.env.MPU_TEST_S3_ACCESS_KEY;
const s3Secret = process.env.MPU_TEST_S3_SECRET_KEY;
const azureConnection = process.env.MPU_TEST_AZURE_CONNECTION_STRING;

export const AVAILABLE: readonly CloudKind[] = [
  ...(s3Endpoint && s3Key && s3Secret ? (['aws_s3', 'minio'] as const) : []),
  ...(azureConnection ? (['azure_blob'] as const) : []),
];

export const MIB = 1024 * 1024;
/** S3's minimum part size; used for every cloud kind so scenarios match. */
export const CLOUD_PART_BYTES = 5 * MIB;

/** Storage options for `kind` in `bucket` (a bucket for S3 kinds, a container for Azure). */
export function storageOptions(kind: CloudKind, bucket: string, extra: StorageOverrides = {}): StorageOverrides {
  const base: StorageOverrides = { storage: kind, ...extra };
  if (kind === 'aws_s3') {
    return {
      ...base,
      s3: {
        bucket,
        region: 'us-east-1',
        endpoint: s3Endpoint as string,
        forcePathStyle: true,
        credentials: { accessKeyId: s3Key as string, secretAccessKey: s3Secret as string },
      },
    };
  }
  if (kind === 'minio') {
    return { ...base, minio: { endpoint: s3Endpoint as string, bucket, accessKey: s3Key as string, secretKey: s3Secret as string } };
  }
  return { ...base, azure: { container: bucket, connectionString: azureConnection as string } };
}

/** The backend instance the uploader will use for these options. */
export async function backendFor(options: StorageOverrides & { partBytes?: number; maxFileBytes?: number }): Promise<CloudBackend> {
  const resolved = resolveStorage(options, resolveConfig(options));
  if (!resolved.backend) throw new Error('not a cloud configuration');
  return cloudBackendFor(resolved.backend);
}

let counter = 0;
/** A bucket / container name unique to this run: lowercase, 3–63 chars. */
export function uniqueBucketName(label: string): string {
  counter += 1;
  return `mpu-${label}-${process.pid}-${Date.now().toString(36)}-${counter}`.toLowerCase().slice(0, 63);
}

/** Create the bucket / container for a test file. */
export async function createBucket(kind: CloudKind, bucket: string): Promise<void> {
  if (kind === 'azure_blob') {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    await BlobServiceClient.fromConnectionString(azureConnection as string).getContainerClient(bucket).createIfNotExists();
    return;
  }
  const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s3Key as string, secretAccessKey: s3Secret as string },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((err: { name?: string }) => {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  });
}

/** Delete everything in the bucket / container, then the bucket / container itself. */
export async function deleteBucket(kind: CloudKind, bucket: string): Promise<void> {
  if (kind === 'azure_blob') {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    await BlobServiceClient.fromConnectionString(azureConnection as string).getContainerClient(bucket).deleteIfExists();
    return;
  }
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s3Key as string, secretAccessKey: s3Secret as string },
  });
  const uploads = await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket })).catch(() => ({ Uploads: [] }));
  for (const u of uploads.Uploads ?? []) {
    await client.send(new sdk.AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId })).catch(() => undefined);
  }
  let token: string | undefined;
  do {
    const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
}

/** Unfinished S3 multipart uploads in a bucket — to prove none are leaked. */
export async function openS3MultipartUploads(bucket: string): Promise<number> {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: s3Key as string, secretAccessKey: s3Secret as string },
  });
  const res = await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket }));
  return res.Uploads?.length ?? 0;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Composite SHA-256 computed independently of the library: SHA-256 of the part digests. */
export function expectedComposite(bytes: Uint8Array, partBytes: number): string {
  const outer = createHash('sha256');
  for (let start = 0; start < bytes.byteLength; start += partBytes) {
    outer.update(createHash('sha256').update(bytes.subarray(start, Math.min(start + partBytes, bytes.byteLength))).digest());
  }
  return outer.digest('hex');
}

/** Read a whole web stream into one buffer. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Wait, in tests only (shipped code never uses timers). */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => AbortSignal.timeout(ms).addEventListener('abort', () => resolve(), { once: true }));
}
