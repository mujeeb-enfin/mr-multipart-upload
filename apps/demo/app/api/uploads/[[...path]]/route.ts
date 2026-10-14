// The whole server side of the upload: one catch-all route.

import { createUploadRoutes } from '@mr_innovations/multipart-upload/server';

import { readVisitorId } from '../../../visitor';

// Filesystem access needs the Node.js runtime, and uploads must never be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createUploadRoutes({
  // Settings. Every one is optional; each one left out falls back to its .env
  // variable (see .env.example), then to the default. Uncomment to set in code:
  //
  //   dir: '/var/data/uploads',          // MULTIPART_UPLOAD_DIR            default ./uploads
  //   maxFileBytes: 500 * 1024 * 1024,   // MULTIPART_UPLOAD_MAX_FILE_BYTES default 500 MiB
  //   partBytes: 2 * 1024 * 1024,        // MULTIPART_UPLOAD_PART_BYTES     default 2 MiB (1–8 MiB)
  //   partTtlMs: 48 * 60 * 60 * 1000,    // MULTIPART_UPLOAD_PART_TTL_HOURS default 48 h
  //   instanceId: 'web-1',               // MULTIPART_UPLOAD_INSTANCE_ID    default "single"
  //
  // The demo leaves them unset so its e2e suite can set a small limit via .env.

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
    storedAs: file.key,
    note: typeof metadata.note === 'string' ? metadata.note : null,
  }),
});

export const { GET, POST, PUT, DELETE } = routes;
