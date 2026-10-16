// ---------------------------------------------------------------------------
// storage-config.ts — which storage, which transfer mode, and its settings
// ---------------------------------------------------------------------------
//
//   storage    'local' (default) | 'aws_s3' | 'minio' | 'azure_blob'
//   transfer   'proxy' (default): browser → this server → storage
//              'direct': browser → storage, with short-lived signed URLs
//
// Same precedence as every setting: the parameter, then the .env variable, then
// the default. Validated on every call; an invalid or missing value throws
// CONFIG_INVALID naming the setting. SECRET VALUES ARE NEVER PUT IN A MESSAGE.
//
// Credentials:
//   aws_s3      `s3.credentials` (an IAM user's keys), or — when omitted — the
//               AWS SDK's default chain: AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY,
//               profiles, SSO, EC2 instance profile, ECS task role, EKS (IRSA).
//   minio       access key + secret key (MinIO has its own users, not IAM).
//   azure_blob  connection string, account key, SAS token, or none → Microsoft
//               Entra ID (managed identity / service principal).
// ---------------------------------------------------------------------------

import { UploadError } from '../core/errors.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { AzureBackendConfig } from '../storage/cloud/azure-backend.js';
import type { S3BackendConfig } from '../storage/cloud/s3-backend.js';
import { MIB, type ResolvedConfig } from './config.js';

export const STORAGE_KINDS = ['local', 'aws_s3', 'minio', 'azure_blob'] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export type TransferMode = 'proxy' | 'direct';

export interface S3StorageOptions {
  /** Falls back to MULTIPART_UPLOAD_S3_BUCKET. */
  bucket?: string;
  /** Falls back to MULTIPART_UPLOAD_S3_REGION, then AWS_REGION / AWS_DEFAULT_REGION. */
  region?: string;
  /** Key prefix for everything stored. Falls back to MULTIPART_UPLOAD_S3_PREFIX. */
  prefix?: string;
  /** S3-compatible endpoint (R2, Wasabi, …). Falls back to MULTIPART_UPLOAD_S3_ENDPOINT. */
  endpoint?: string;
  /** Path-style addressing. Falls back to MULTIPART_UPLOAD_S3_FORCE_PATH_STYLE, then false. */
  forcePathStyle?: boolean;
  /** An IAM user's keys. Omit to use the AWS SDK default credential chain (IAM roles). */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

export interface MinioStorageOptions {
  /** e.g. https://minio.example.com:9000. Falls back to MULTIPART_UPLOAD_MINIO_ENDPOINT. */
  endpoint?: string;
  /** Falls back to MULTIPART_UPLOAD_MINIO_BUCKET. */
  bucket?: string;
  /** Falls back to MULTIPART_UPLOAD_MINIO_ACCESS_KEY. */
  accessKey?: string;
  /** Falls back to MULTIPART_UPLOAD_MINIO_SECRET_KEY. */
  secretKey?: string;
  /** Falls back to MULTIPART_UPLOAD_MINIO_REGION, then us-east-1. */
  region?: string;
  /** Falls back to MULTIPART_UPLOAD_MINIO_PREFIX. */
  prefix?: string;
}

export interface AzureStorageOptions {
  /** Falls back to MULTIPART_UPLOAD_AZURE_CONTAINER. */
  container?: string;
  /** Falls back to MULTIPART_UPLOAD_AZURE_PREFIX. */
  prefix?: string;
  /** Falls back to MULTIPART_UPLOAD_AZURE_CONNECTION_STRING, then AZURE_STORAGE_CONNECTION_STRING. */
  connectionString?: string;
  /** https://<account>.blob.core.windows.net. Falls back to MULTIPART_UPLOAD_AZURE_ACCOUNT_URL. */
  accountUrl?: string;
  /** Falls back to MULTIPART_UPLOAD_AZURE_ACCOUNT_NAME; otherwise read from the URL. */
  accountName?: string;
  /** Falls back to MULTIPART_UPLOAD_AZURE_ACCOUNT_KEY. */
  accountKey?: string;
  /** Falls back to MULTIPART_UPLOAD_AZURE_SAS_TOKEN. Cannot sign direct-transfer URLs. */
  sasToken?: string;
}

export interface StorageOverrides {
  /**
   * 'local' | 'aws_s3' | 'minio' | 'azure_blob', or a custom StorageAdapter.
   * Falls back to MULTIPART_UPLOAD_STORAGE, then 'local'.
   */
  storage?: StorageAdapter | StorageKind;
  /** 'proxy' | 'direct'. Falls back to MULTIPART_UPLOAD_TRANSFER, then 'proxy'. */
  transfer?: TransferMode;
  /** Lifetime of a direct-transfer URL. Falls back to MULTIPART_UPLOAD_DIRECT_URL_TTL_SECONDS, then 900. */
  directUrlTtlSeconds?: number;
  s3?: S3StorageOptions;
  minio?: MinioStorageOptions;
  azure?: AzureStorageOptions;
}

export interface ResolvedStorage {
  readonly kind: StorageKind | 'custom';
  readonly transfer: TransferMode;
  readonly directUrlTtlSeconds: number;
  /** Set for the cloud kinds. */
  readonly backend?: S3BackendConfig | AzureBackendConfig;
}

/** S3 refuses parts under 5 MiB (except the last) and more than 10,000 parts. */
export const S3_MIN_PART_BYTES = 5 * MIB;
export const S3_MAX_PARTS = 10_000;
/** Azure commits at most 50,000 blocks per blob. */
export const AZURE_MAX_BLOCKS = 50_000;
/** S3 presigned URLs may live 7 days at most. */
const MAX_DIRECT_TTL_SECONDS = 7 * 24 * 60 * 60;

const ENV = {
  storage: 'MULTIPART_UPLOAD_STORAGE',
  transfer: 'MULTIPART_UPLOAD_TRANSFER',
  ttl: 'MULTIPART_UPLOAD_DIRECT_URL_TTL_SECONDS',
} as const;

function invalid(setting: string, message: string): never {
  throw new UploadError('CONFIG_INVALID', `${setting} ${message}`);
}

/** The parameter, else the first non-empty env variable, trimmed. */
function pick(option: string | undefined, ...envNames: string[]): string | undefined {
  if (option !== undefined && option.trim() !== '') return option.trim();
  for (const name of envNames) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function required(value: string | undefined, setting: string, forKind: string): string {
  if (value === undefined) invalid(setting, `is required for storage "${forKind}"`);
  return value;
}

function validUrl(value: string, setting: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    return value.replace(/\/+$/, '');
  } catch {
    return invalid(setting, 'must be an http(s) URL');
  }
}

/** '' or 'a/b/' — no leading slash, no '..', always ending in '/'. */
function normalisePrefix(value: string | undefined, setting: string): string {
  if (value === undefined) return '';
  const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (trimmed.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid(setting, 'must be a plain path such as "uploads" or "app/uploads"');
  }
  return `${trimmed}/`;
}

function parseBoolean(value: string | undefined, setting: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  return invalid(setting, 'must be true or false');
}

function resolveS3(options: S3StorageOptions = {}): S3BackendConfig {
  const bucket = required(pick(options.bucket, 'MULTIPART_UPLOAD_S3_BUCKET'), 's3.bucket (MULTIPART_UPLOAD_S3_BUCKET)', 'aws_s3');
  const region = required(
    pick(options.region, 'MULTIPART_UPLOAD_S3_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION'),
    's3.region (MULTIPART_UPLOAD_S3_REGION or AWS_REGION)',
    'aws_s3',
  );
  const endpoint = pick(options.endpoint, 'MULTIPART_UPLOAD_S3_ENDPOINT');
  const forcePathStyle =
    options.forcePathStyle ??
    parseBoolean(pick(undefined, 'MULTIPART_UPLOAD_S3_FORCE_PATH_STYLE'), 'MULTIPART_UPLOAD_S3_FORCE_PATH_STYLE') ??
    false;
  const { credentials } = options;
  if (credentials && (!credentials.accessKeyId || !credentials.secretAccessKey)) {
    invalid('s3.credentials', 'needs both accessKeyId and secretAccessKey (or omit it to use IAM roles)');
  }
  return {
    kind: 'aws_s3',
    bucket,
    region,
    prefix: normalisePrefix(pick(options.prefix, 'MULTIPART_UPLOAD_S3_PREFIX'), 's3.prefix (MULTIPART_UPLOAD_S3_PREFIX)'),
    ...(endpoint ? { endpoint: validUrl(endpoint, 's3.endpoint (MULTIPART_UPLOAD_S3_ENDPOINT)') } : {}),
    forcePathStyle,
    // Copied field by field: the AWS SDK annotates the credentials object it is
    // given (`$source`). Passing the caller's object through let that write
    // change this configuration's cache key — a second client per config — and
    // modify the application's own options.
    ...(credentials
      ? {
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
          },
        }
      : {}),
  };
}

function resolveMinio(options: MinioStorageOptions = {}): S3BackendConfig {
  const kind = 'minio';
  const endpoint = required(pick(options.endpoint, 'MULTIPART_UPLOAD_MINIO_ENDPOINT'), 'minio.endpoint (MULTIPART_UPLOAD_MINIO_ENDPOINT)', kind);
  const bucket = required(pick(options.bucket, 'MULTIPART_UPLOAD_MINIO_BUCKET'), 'minio.bucket (MULTIPART_UPLOAD_MINIO_BUCKET)', kind);
  const accessKeyId = required(pick(options.accessKey, 'MULTIPART_UPLOAD_MINIO_ACCESS_KEY'), 'minio.accessKey (MULTIPART_UPLOAD_MINIO_ACCESS_KEY)', kind);
  const secretAccessKey = required(pick(options.secretKey, 'MULTIPART_UPLOAD_MINIO_SECRET_KEY'), 'minio.secretKey (MULTIPART_UPLOAD_MINIO_SECRET_KEY)', kind);
  return {
    kind,
    bucket,
    region: pick(options.region, 'MULTIPART_UPLOAD_MINIO_REGION') ?? 'us-east-1',
    prefix: normalisePrefix(pick(options.prefix, 'MULTIPART_UPLOAD_MINIO_PREFIX'), 'minio.prefix (MULTIPART_UPLOAD_MINIO_PREFIX)'),
    endpoint: validUrl(endpoint, 'minio.endpoint (MULTIPART_UPLOAD_MINIO_ENDPOINT)'),
    // MinIO serves buckets by path unless it is set up for virtual hosts.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  };
}

function resolveAzure(options: AzureStorageOptions = {}): AzureBackendConfig {
  const kind = 'azure_blob';
  const container = required(pick(options.container, 'MULTIPART_UPLOAD_AZURE_CONTAINER'), 'azure.container (MULTIPART_UPLOAD_AZURE_CONTAINER)', kind);
  if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) {
    invalid('azure.container (MULTIPART_UPLOAD_AZURE_CONTAINER)', 'must be 3–63 lowercase letters, digits and single hyphens');
  }
  const connectionString = pick(options.connectionString, 'MULTIPART_UPLOAD_AZURE_CONNECTION_STRING', 'AZURE_STORAGE_CONNECTION_STRING');
  const accountUrl = pick(options.accountUrl, 'MULTIPART_UPLOAD_AZURE_ACCOUNT_URL');
  if (!connectionString && !accountUrl) {
    invalid(
      'azure.accountUrl (MULTIPART_UPLOAD_AZURE_ACCOUNT_URL) or azure.connectionString (AZURE_STORAGE_CONNECTION_STRING)',
      'is required for storage "azure_blob"',
    );
  }
  const accountName = pick(options.accountName, 'MULTIPART_UPLOAD_AZURE_ACCOUNT_NAME');
  const accountKey = pick(options.accountKey, 'MULTIPART_UPLOAD_AZURE_ACCOUNT_KEY');
  const sasToken = pick(options.sasToken, 'MULTIPART_UPLOAD_AZURE_SAS_TOKEN');
  return {
    kind,
    container,
    prefix: normalisePrefix(pick(options.prefix, 'MULTIPART_UPLOAD_AZURE_PREFIX'), 'azure.prefix (MULTIPART_UPLOAD_AZURE_PREFIX)'),
    ...(connectionString ? { connectionString } : {}),
    ...(accountUrl ? { accountUrl: validUrl(accountUrl, 'azure.accountUrl (MULTIPART_UPLOAD_AZURE_ACCOUNT_URL)') } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountKey ? { accountKey } : {}),
    ...(sasToken ? { sasToken } : {}),
  };
}

export function resolveStorage(options: StorageOverrides, config: ResolvedConfig): ResolvedStorage {
  let kind: StorageKind | 'custom';
  if (options.storage != null && typeof options.storage !== 'string') {
    kind = 'custom';
  } else {
    const raw = pick(options.storage, ENV.storage) ?? 'local';
    if (!(STORAGE_KINDS as readonly string[]).includes(raw)) {
      invalid(`storage (${ENV.storage})`, `must be one of ${STORAGE_KINDS.join(', ')}, got "${raw}"`);
    }
    kind = raw as StorageKind;
  }

  const transferRaw = pick(options.transfer, ENV.transfer) ?? 'proxy';
  if (transferRaw !== 'proxy' && transferRaw !== 'direct') {
    invalid(`transfer (${ENV.transfer})`, `must be "proxy" or "direct", got "${transferRaw}"`);
  }
  const transfer: TransferMode = transferRaw;
  if (transfer === 'direct' && (kind === 'local' || kind === 'custom')) {
    invalid(`transfer (${ENV.transfer})`, `"direct" needs a cloud storage (aws_s3, minio or azure_blob); storage is "${kind}"`);
  }

  const ttlRaw = options.directUrlTtlSeconds ?? pick(undefined, ENV.ttl);
  const directUrlTtlSeconds = ttlRaw === undefined ? 900 : Number(ttlRaw);
  if (!Number.isSafeInteger(directUrlTtlSeconds) || directUrlTtlSeconds < 1 || directUrlTtlSeconds > MAX_DIRECT_TTL_SECONDS) {
    invalid(`directUrlTtlSeconds (${ENV.ttl})`, `must be a whole number of seconds from 1 to ${MAX_DIRECT_TTL_SECONDS}`);
  }

  let backend: S3BackendConfig | AzureBackendConfig | undefined;
  if (kind === 'aws_s3') backend = resolveS3(options.s3);
  else if (kind === 'minio') backend = resolveMinio(options.minio);
  else if (kind === 'azure_blob') backend = resolveAzure(options.azure);

  // The provider's own limits, checked against the configured sizes now — not
  // discovered by a user halfway through an upload.
  if (kind === 'aws_s3' || kind === 'minio') {
    if (config.partBytes < S3_MIN_PART_BYTES) {
      invalid('partBytes (MULTIPART_UPLOAD_PART_BYTES)', `must be at least ${S3_MIN_PART_BYTES} (5 MiB) for storage "${kind}": S3 refuses smaller parts`);
    }
    if (Math.ceil(config.maxFileBytes / config.partBytes) > S3_MAX_PARTS) {
      invalid('maxFileBytes (MULTIPART_UPLOAD_MAX_FILE_BYTES)', `needs more than ${S3_MAX_PARTS} parts at this part size; S3 allows ${S3_MAX_PARTS}. Raise partBytes or lower the limit`);
    }
  }
  if (kind === 'azure_blob' && Math.ceil(config.maxFileBytes / config.partBytes) > AZURE_MAX_BLOCKS) {
    invalid('maxFileBytes (MULTIPART_UPLOAD_MAX_FILE_BYTES)', `needs more than ${AZURE_MAX_BLOCKS} parts at this part size; Azure allows ${AZURE_MAX_BLOCKS} blocks. Raise partBytes or lower the limit`);
  }
  // A SAS token cannot sign new SAS URLs — whether passed alone or inside a
  // connection string (`SharedAccessSignature=` with no `AccountKey=`).
  // `UseDevelopmentStorage=true` is Azurite's shorthand; it carries the
  // emulator's well-known account key, so it can sign.
  const sasOnlyConnectionString =
    backend?.kind === 'azure_blob' &&
    !!backend.connectionString &&
    !/(^|;)\s*(AccountKey\s*=|UseDevelopmentStorage\s*=\s*true)/i.test(backend.connectionString);
  const sasOnly =
    backend?.kind === 'azure_blob' && ((!!backend.sasToken && !backend.accountKey && !backend.connectionString) || sasOnlyConnectionString);
  if (transfer === 'direct' && sasOnly) {
    invalid(`transfer (${ENV.transfer})`, '"direct" with storage "azure_blob" needs an account key or Entra ID to sign upload URLs; a SAS token cannot sign new ones');
  }

  return { kind, transfer, directUrlTtlSeconds, ...(backend ? { backend } : {}) };
}
