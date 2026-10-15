// Public server API — `@mr_innovations/multipart-upload/server`.

export { createUploadRoutes, FINGERPRINT_HEADER, PART_CHECKSUM_HEADER } from './routes.js';
export type { UploadRoutes, UploadRoutesOptions, RouteHandler } from './routes.js';

export { createUploader } from './uploader.js';
export type {
  Uploader,
  UploaderOptions,
  UploadContext,
  BeginInput,
  PutPartInput,
  PutPartResult,
  PresignPartInput,
  PresignPartResult,
  TransferInfo,
} from './uploader.js';

// Storage: 'local' | 'aws_s3' | 'minio' | 'azure_blob', transfer 'proxy' | 'direct'.
export { resolveStorage, STORAGE_KINDS, S3_MIN_PART_BYTES, S3_MAX_PARTS, AZURE_MAX_BLOCKS } from './storage-config.js';
export type {
  StorageKind,
  TransferMode,
  StorageOverrides,
  S3StorageOptions,
  MinioStorageOptions,
  AzureStorageOptions,
  ResolvedStorage,
} from './storage-config.js';
export type { CloudBackend, CloudPart, DirectPartRequest, CloudCommitResult } from '../storage/cloud/types.js';

export type { CompleteHookInput, CompleteResult, CompletedFile } from './complete.js';
export type { SweepResult } from './sweep.js';
export type { SessionView } from './store.js';

export { resolveConfig, ENV, MIN_PART_BYTES, MAX_PART_BYTES } from './config.js';
export type { ConfigOverrides, ResolvedConfig } from './config.js';

export { FsStorage } from '../storage/fs-storage.js';
export type { StorageAdapter, StoredObjectInfo, AssemblyResult } from '../storage/adapter.js';

export { UploadError, isUploadError } from '../core/errors.js';
export type { UploadErrorCode } from '../core/errors.js';
export type {
  UploadMetadata,
  JsonValue,
  UploadManifest,
  UploadSession,
  FileChecksum,
  CloudSessionRef,
  CommittedFileRef,
} from '../core/session.js';
export { slugifyFileName, uploadIdForFileName } from '../core/slug.js';

// Ready-made allowedTypes lists: allowedTypes: [...FILE_TYPES.images, ...FILE_TYPES.pdf]
export { FILE_TYPES } from '../core/file-type-presets.js';
export type { FileTypePreset } from '../core/file-type-presets.js';

// For applications that want the same content check inside validateHead.
export { detectFileType, typeForExtension } from '../core/file-signatures.js';
export type { DetectedFileType } from '../core/file-signatures.js';
