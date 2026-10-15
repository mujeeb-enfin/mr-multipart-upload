// ---------------------------------------------------------------------------
// upload-settings.ts — the demo's upload settings, set in code
// ---------------------------------------------------------------------------
//
// Passed to createUploadRoutes() in app/api/uploads/[[...path]]/route.ts.
// A setting given in code WINS over its .env variable; a setting left out falls
// back to .env (see .env.example), then to the package default.
//
// Imported by the e2e suite too, so the tests assert against exactly these values.
// ---------------------------------------------------------------------------

import { FILE_TYPES } from '@mr_innovations/multipart-upload/server';

const MB = 1024 * 1024;

/** 1. Largest file accepted, in bytes. Package default: 500 MB. */
export const DEMO_MAX_FILE_BYTES = 500 * MB;

/**
 * 2. Size of each uploaded part, in bytes, between 1 MB and 8 MB. Package
 * default: 2 MB. The demo uses 5 MB — S3's minimum part size — so the same
 * settings work on every storage: local, aws_s3, minio and azure_blob.
 */
export const DEMO_PART_BYTES = 5 * MB;

/**
 * 3. File types accepted. One example of each kind of entry:
 *
 *   ...FILE_TYPES.webImages   a ready-made list (JPEG, PNG, GIF, WebP)
 *   'video/*', 'audio/*'      wildcards: every video and audio type
 *   'application/pdf'         one exact MIME type
 *   '.zip'                    an extension
 *
 * Every file is checked twice: by its declared type when the upload starts,
 * and by its real content before it is stored — so an .exe renamed to .png is
 * refused. More presets: FILE_TYPES.images, .documents, .spreadsheets, .text,
 * .audio, .video, .archives (see the package README for the full list).
 * Package default: every type.
 */
export const DEMO_ALLOWED_TYPES: readonly string[] = [
  ...FILE_TYPES.webImages,
  'video/*',
  'audio/*',
  'application/pdf',
  '.zip',
];
