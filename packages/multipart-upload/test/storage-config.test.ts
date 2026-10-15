// ---------------------------------------------------------------------------
// storage-config.test.ts — choosing and configuring a storage backend
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. A misconfigured backend must fail at startup with a
// message naming the setting — never halfway through a user's upload, and
// never with a secret in the message. Covers precedence (parameter → .env →
// default), every required setting per kind, the providers' own limits checked
// against the configured sizes, and direct transfer's preconditions.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../src/server/config.js';
import { resolveStorage, type StorageOverrides } from '../src/server/storage-config.js';
import { loadOptional } from '../src/storage/cloud/load-optional.js';
import { FsStorage } from '../src/storage/fs-storage.js';
import { MIB } from './helpers.js';

const STORAGE_ENV = Object.keys(process.env).filter((k) => k.startsWith('MULTIPART_UPLOAD_') || k.startsWith('AWS_') || k.startsWith('AZURE_'));
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(STORAGE_ENV.map((k) => [k, process.env[k]]));
  for (const k of STORAGE_ENV) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(process.env)) {
    if ((k.startsWith('MULTIPART_UPLOAD_') || k.startsWith('AZURE_STORAGE')) && !(k in saved)) delete process.env[k];
  }
});

const resolve = (options: StorageOverrides & { partBytes?: number; maxFileBytes?: number } = {}) =>
  resolveStorage(options, resolveConfig(options));
const message = (fn: () => unknown): string => {
  try {
    fn();
    return 'no error';
  } catch (err) {
    return (err as Error).message;
  }
};

const S3 = { bucket: 'b', region: 'eu-west-1' };
const MINIO = { endpoint: 'http://127.0.0.1:9000', bucket: 'b', accessKey: 'ak', secretKey: 'super-secret-value' };

describe('choosing storage and transfer', () => {
  it('defaults to local storage with proxy transfer', () => {
    expect(resolve()).toEqual({ kind: 'local', transfer: 'proxy', directUrlTtlSeconds: 900 });
  });

  it('reads MULTIPART_UPLOAD_STORAGE and _TRANSFER, and a parameter wins over both', () => {
    process.env.MULTIPART_UPLOAD_STORAGE = 'minio';
    process.env.MULTIPART_UPLOAD_MINIO_ENDPOINT = MINIO.endpoint;
    process.env.MULTIPART_UPLOAD_MINIO_BUCKET = 'env-bucket';
    process.env.MULTIPART_UPLOAD_MINIO_ACCESS_KEY = 'ak';
    process.env.MULTIPART_UPLOAD_MINIO_SECRET_KEY = 'sk';
    process.env.MULTIPART_UPLOAD_TRANSFER = 'direct';
    expect(resolve({ partBytes: 5 * MIB })).toMatchObject({ kind: 'minio', transfer: 'direct', backend: { bucket: 'env-bucket' } });
    expect(resolve({ storage: 'local', transfer: 'proxy' })).toMatchObject({ kind: 'local', transfer: 'proxy' });
  });

  it('a StorageAdapter object is a custom backend', () => {
    expect(resolve({ storage: new FsStorage('.') }).kind).toBe('custom');
  });

  it('refuses an unknown kind or transfer, naming the variable', () => {
    process.env.MULTIPART_UPLOAD_STORAGE = 's3';
    expect(message(() => resolve())).toBe('storage (MULTIPART_UPLOAD_STORAGE) must be one of local, aws_s3, minio, azure_blob, got "s3"');
    expect(message(() => resolve({ storage: 'local', transfer: 'fast' as never }))).toBe(
      'transfer (MULTIPART_UPLOAD_TRANSFER) must be "proxy" or "direct", got "fast"',
    );
  });

  it('refuses direct transfer for local storage', () => {
    expect(message(() => resolve({ transfer: 'direct' }))).toBe(
      'transfer (MULTIPART_UPLOAD_TRANSFER) "direct" needs a cloud storage (aws_s3, minio or azure_blob); storage is "local"',
    );
  });

  it('bounds the direct URL lifetime', () => {
    expect(message(() => resolve({ storage: 'aws_s3', s3: S3, partBytes: 5 * MIB, directUrlTtlSeconds: 0 }))).toContain('from 1 to 604800');
    expect(resolve({ storage: 'aws_s3', s3: S3, partBytes: 5 * MIB, directUrlTtlSeconds: 60 }).directUrlTtlSeconds).toBe(60);
  });
});

describe('optional SDKs', () => {
  it('a missing SDK fails with what to install, not a module-resolution stack trace', async () => {
    const err = await loadOptional('@mr-innovations-test/not-installed-sdk', 'storage "aws_s3"').catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'CONFIG_INVALID',
      message: 'storage "aws_s3" needs the optional package @mr-innovations-test/not-installed-sdk. Install it: npm install @mr-innovations-test/not-installed-sdk',
    });
  });
});

describe('aws_s3', () => {
  it('needs a bucket and a region, taking AWS_REGION as the region fallback', () => {
    expect(message(() => resolve({ storage: 'aws_s3', partBytes: 5 * MIB }))).toBe(
      's3.bucket (MULTIPART_UPLOAD_S3_BUCKET) is required for storage "aws_s3"',
    );
    expect(message(() => resolve({ storage: 'aws_s3', s3: { bucket: 'b' }, partBytes: 5 * MIB }))).toBe(
      's3.region (MULTIPART_UPLOAD_S3_REGION or AWS_REGION) is required for storage "aws_s3"',
    );
    process.env.AWS_REGION = 'ap-south-1';
    expect(resolve({ storage: 'aws_s3', s3: { bucket: 'b' }, partBytes: 5 * MIB }).backend).toMatchObject({ region: 'ap-south-1' });
  });

  it('uses the IAM default credential chain when no keys are given, and the keys when they are', () => {
    expect(resolve({ storage: 'aws_s3', s3: S3, partBytes: 5 * MIB }).backend).not.toHaveProperty('credentials');
    const keys = { accessKeyId: 'AKIA', secretAccessKey: 'shh' };
    expect(resolve({ storage: 'aws_s3', s3: { ...S3, credentials: keys }, partBytes: 5 * MIB }).backend).toMatchObject({ credentials: keys });
    expect(message(() => resolve({ storage: 'aws_s3', s3: { ...S3, credentials: { accessKeyId: 'AKIA' } as never }, partBytes: 5 * MIB }))).toBe(
      's3.credentials needs both accessKeyId and secretAccessKey (or omit it to use IAM roles)',
    );
  });

  it('enforces S3 part limits against the configured sizes', () => {
    expect(message(() => resolve({ storage: 'aws_s3', s3: S3, partBytes: 2 * MIB }))).toBe(
      'partBytes (MULTIPART_UPLOAD_PART_BYTES) must be at least 5242880 (5 MiB) for storage "aws_s3": S3 refuses smaller parts',
    );
    expect(message(() => resolve({ storage: 'aws_s3', s3: S3, partBytes: 5 * MIB, maxFileBytes: 60_000 * MIB }))).toContain(
      'needs more than 10000 parts at this part size; S3 allows 10000',
    );
  });

  it('normalises the key prefix and refuses traversal', () => {
    expect(resolve({ storage: 'aws_s3', s3: { ...S3, prefix: '/app/uploads/' }, partBytes: 5 * MIB }).backend).toMatchObject({ prefix: 'app/uploads/' });
    expect(message(() => resolve({ storage: 'aws_s3', s3: { ...S3, prefix: 'a/../b' }, partBytes: 5 * MIB }))).toContain('must be a plain path');
  });
});

describe('minio', () => {
  it('needs endpoint, bucket and both keys, and always uses path-style addressing', () => {
    expect(message(() => resolve({ storage: 'minio', partBytes: 5 * MIB }))).toBe(
      'minio.endpoint (MULTIPART_UPLOAD_MINIO_ENDPOINT) is required for storage "minio"',
    );
    expect(message(() => resolve({ storage: 'minio', minio: { ...MINIO, secretKey: undefined }, partBytes: 5 * MIB }))).toBe(
      'minio.secretKey (MULTIPART_UPLOAD_MINIO_SECRET_KEY) is required for storage "minio"',
    );
    expect(resolve({ storage: 'minio', minio: MINIO, partBytes: 5 * MIB }).backend).toMatchObject({
      kind: 'minio',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'super-secret-value' },
    });
  });

  it('refuses a non-URL endpoint without echoing any secret', () => {
    const msg = message(() => resolve({ storage: 'minio', minio: { ...MINIO, endpoint: 'not a url' }, partBytes: 5 * MIB }));
    expect(msg).toBe('minio.endpoint (MULTIPART_UPLOAD_MINIO_ENDPOINT) must be an http(s) URL');
    expect(msg).not.toContain('super-secret-value');
  });
});

describe('azure_blob', () => {
  const CS = 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net';

  it('needs a valid container and a connection string or account URL', () => {
    expect(message(() => resolve({ storage: 'azure_blob', azure: { connectionString: CS } }))).toBe(
      'azure.container (MULTIPART_UPLOAD_AZURE_CONTAINER) is required for storage "azure_blob"',
    );
    expect(message(() => resolve({ storage: 'azure_blob', azure: { container: 'Bad_Name', connectionString: CS } }))).toContain(
      'must be 3–63 lowercase letters, digits and single hyphens',
    );
    expect(message(() => resolve({ storage: 'azure_blob', azure: { container: 'uploads' } }))).toContain('is required for storage "azure_blob"');
  });

  it('takes AZURE_STORAGE_CONNECTION_STRING as a fallback, and an account URL alone means Entra ID', () => {
    process.env.AZURE_STORAGE_CONNECTION_STRING = CS;
    expect(resolve({ storage: 'azure_blob', azure: { container: 'uploads' } }).backend).toMatchObject({ connectionString: CS });
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    const entra = resolve({ storage: 'azure_blob', azure: { container: 'uploads', accountUrl: 'https://acct.blob.core.windows.net' } }).backend;
    expect(entra).toEqual({ kind: 'azure_blob', container: 'uploads', prefix: '', accountUrl: 'https://acct.blob.core.windows.net' });
  });

  it('refuses direct transfer with only a SAS token, which cannot sign new URLs', () => {
    expect(
      message(() =>
        resolve({ storage: 'azure_blob', transfer: 'direct', azure: { container: 'uploads', accountUrl: 'https://acct.blob.core.windows.net', sasToken: 'sv=x' } }),
      ),
    ).toContain('needs an account key or Entra ID to sign upload URLs');
  });

  it('enforces Azure\'s 50,000-block limit', () => {
    expect(message(() => resolve({ storage: 'azure_blob', azure: { container: 'uploads', connectionString: CS }, partBytes: MIB, maxFileBytes: 60_000 * MIB }))).toContain(
      'Azure allows 50000 blocks',
    );
  });
});
