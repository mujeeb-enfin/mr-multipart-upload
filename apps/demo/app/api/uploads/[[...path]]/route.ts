// The whole server side of the upload: one catch-all route.

import { createUploadRoutes } from 'multipart-upload/server';

// Filesystem access needs the Node.js runtime, and uploads must never be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const routes = createUploadRoutes({
  // DEMO ONLY. A real application identifies the signed-in user here, e.g.
  //   authorize: async () => {
  //     const session = await auth();
  //     return session?.user?.id ? { namespace: session.user.id } : null;
  //   },
  // so each user's uploads are isolated from everyone else's.
  allowAnonymous: true,

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
