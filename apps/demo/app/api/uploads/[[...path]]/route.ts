// The whole server side of the upload: one catch-all route.

import { createUploadRoutes } from '@mr_innovations/multipart-upload/server';

import { DEMO_ALLOWED_TYPES, DEMO_MAX_FILE_BYTES, DEMO_PART_BYTES } from '../../../upload-settings';
import { readVisitorId } from '../../../visitor';

// Filesystem access needs the Node.js runtime, and uploads must never be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createUploadRoutes({
  // ── The three main settings, set in code (values in app/upload-settings.ts) ──
  // Each one set here wins over its .env variable. Leave one out to fall back to
  // .env (see .env.example), then to the package default.

  // 1. Largest file accepted: 500 MB.          .env: MULTIPART_UPLOAD_MAX_FILE_BYTES
  maxFileBytes: DEMO_MAX_FILE_BYTES,

  // 2. Size of each uploaded part: 2 MB (1–8). .env: MULTIPART_UPLOAD_PART_BYTES
  partBytes: DEMO_PART_BYTES,

  // 3. File types accepted: JPEG, PNG, GIF, WebP, any video, any audio, PDF, .zip.
  //    .env: MULTIPART_UPLOAD_ALLOWED_TYPES. Other ways to write it:
  //      allowedTypes: ['image/*', 'application/pdf'],                  // wildcard + exact type
  //      allowedTypes: [...FILE_TYPES.images, ...FILE_TYPES.documents], // ready-made lists
  //      allowedTypes: ['.zip', '.csv'],                                 // by extension
  //    FILE_TYPES is exported next to createUploadRoutes.
  allowedTypes: DEMO_ALLOWED_TYPES,

  // ── Further optional settings, left to .env / their defaults here ──
  //   dir: '/var/data/uploads',          // MULTIPART_UPLOAD_DIR            default ./uploads
  //   partTtlMs: 48 * 60 * 60 * 1000,    // MULTIPART_UPLOAD_PART_TTL_HOURS default 48 h
  //   instanceId: 'web-1',               // MULTIPART_UPLOAD_INSTANCE_ID    default "single"

  // Who is uploading. A real application returns the signed-in user's id, e.g.
  //   const session = await auth();
  //   return session?.user?.id ? { namespace: session.user.id } : null;
  //
  // The demo has no accounts, so each browser gets a visitor id in a cookie and
  // that is the namespace: two visitors never see each other's uploads, exactly
  // as two users of a real app would not. A request without the cookie is
  // refused, so nothing is ever stored without an owner.
  authorize: (request) => {
    const visitor = readVisitorId(request.headers.get('cookie'));
    return visitor ? { namespace: `demo-visitor:${visitor}` } : null;
  },

  // Called once the file is assembled and stored. Record it in your database
  // here; whatever this returns is sent to the browser as `result`.
  onComplete: ({ file, metadata }) => ({
    fileName: file.fileName,
    size: file.size,
    sha256: file.sha256,
    contentType: file.contentType, // verified from the content where possible
    storedAs: file.key,
    note: typeof metadata.note === 'string' ? metadata.note : null,
  }),
});

export const { GET, POST, PUT, DELETE } = routes;
