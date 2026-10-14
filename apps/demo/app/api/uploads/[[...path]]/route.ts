// The whole server side of the upload: one catch-all route.

import { createUploadRoutes } from 'multipart-upload/server';

import { readVisitorId } from '../../../visitor';

// Filesystem access needs the Node.js runtime, and uploads must never be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createUploadRoutes({
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
