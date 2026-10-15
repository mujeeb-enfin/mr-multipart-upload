// ---------------------------------------------------------------------------
// routes.ts — Next.js App Router handlers for one catch-all route
// ---------------------------------------------------------------------------
//
//   // app/api/uploads/[[...path]]/route.ts
//   export const runtime = 'nodejs';
//   export const { GET, POST, PUT, DELETE } = createUploadRoutes({ authorize });
//
//   POST   /api/uploads                     begin or resume
//   GET    /api/uploads                     the caller's unfinished uploads
//   GET    /api/uploads/:id                 status
//   PUT    /api/uploads/:id/parts/:n        one part (raw body)
//   POST   /api/uploads/:id/complete        assemble and store
//   DELETE /api/uploads/:id                 discard
//
// The path is read from the request URL rather than Next.js route params, so the
// handlers are plain `(Request) => Response` functions — identical across Next
// versions, and testable without a server.
//
// SECURE BY DEFAULT. `authorize` is required; leaving it out throws when the
// route module loads, so a misconfiguration fails `next build`, not production.
// Anonymous uploads need an explicit `allowAnonymous: true`.
//
// BODY LIMITS ARE ENFORCED HERE, because a library cannot ship the edge proxy
// that would otherwise do it. A part is refused on Content-Length before it is
// read, and the read itself stops at the limit if that header lies.
// ---------------------------------------------------------------------------

import { UploadError } from '../core/errors.js';
import { StoragePathError } from '../storage/safe-path.js';
import { MAX_PART_BYTES } from './config.js';
import { ANONYMOUS_NAMESPACE } from './namespace.js';
import { sessionView } from './store.js';
import { createUploader, type UploadContext, type Uploader, type UploaderOptions } from './uploader.js';

export const FINGERPRINT_HEADER = 'x-upload-fingerprint';
/** Optional: lowercase hex SHA-256 of the part, computed by the client before sending. */
export const PART_CHECKSUM_HEADER = 'x-part-sha256';

export interface UploadRoutesOptions extends UploaderOptions {
  /** URL path the route is mounted at. Default '/api/uploads'. */
  basePath?: string;
  /**
   * Identify the caller. Return `{ namespace }` — usually the user id — or null
   * to refuse with 401. Uploads are isolated per namespace.
   */
  authorize?: (request: Request) => UploadContext | null | Promise<UploadContext | null>;
  /** Accept uploads without `authorize`. All anonymous callers share one namespace. */
  allowAnonymous?: boolean;
  /** Called with every unexpected (500) error. Default: console.error. */
  onError?: (error: unknown, request: Request) => void;
}

export type RouteHandler = (request: Request) => Promise<Response>;

export interface UploadRoutes {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  DELETE: RouteHandler;
  /** The underlying uploader, e.g. to call `sweep()` from a cron route. */
  uploader: Uploader;
}

const NO_STORE = { 'cache-control': 'no-store' };
const JSON_OVERHEAD_BYTES = 8 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function errorResponse(err: UploadError): Response {
  return json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
}

/** Read a request body, refusing anything larger than `max` bytes. */
async function readBodyCapped(request: Request, max: number, what: string): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    throw new UploadError('BODY_TOO_LARGE', `${what} is ${declared} bytes; at most ${max} are accepted.`);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // The body stream failed: the client disconnected (ECONNRESET) — what a
      // pause or discard does to in-flight parts. A client event, not a server
      // fault, so it must not reach onError: every pause used to log an error.
      throw new UploadError('CLIENT_DISCONNECTED', `${what} was not received in full; the client disconnected.`);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      // The header lied or was absent. Stop reading rather than buffer it all.
      await reader.cancel().catch(() => undefined);
      throw new UploadError('BODY_TOO_LARGE', `${what} exceeds ${max} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  const bytes = await readBodyCapped(request, max, 'Request body');
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UploadError('INVALID_REQUEST', 'Request body must be a JSON object.');
}

function normaliseBasePath(basePath: string): string {
  const withSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

export function createUploadRoutes(options: UploadRoutesOptions = {}): UploadRoutes {
  if (!options.authorize && !options.allowAnonymous) {
    throw new Error(
      'multipart-upload: createUploadRoutes() needs an `authorize` function that returns { namespace } ' +
        'for the signed-in user. To accept anonymous uploads deliberately, pass `allowAnonymous: true`.',
    );
  }

  const uploader = createUploader(options);
  const basePath = normaliseBasePath(options.basePath ?? '/api/uploads');
  const maxJsonBytes = (options.maxMetadataBytes ?? 16 * 1024) + JSON_OVERHEAD_BYTES;
  const reportError = options.onError ?? ((error: unknown) => console.error('[multipart-upload]', error));

  function segmentsOf(request: Request): string[] {
    const { pathname } = new URL(request.url);
    const path = pathname.replace(/\/+$/, '');
    if (path !== basePath && !path.startsWith(`${basePath}/`)) {
      throw new UploadError(
        'NOT_FOUND',
        `Request path "${pathname}" is not under "${basePath}". Set the \`basePath\` option to the URL ` +
          'this route is mounted at.',
      );
    }
    try {
      return path.slice(basePath.length).split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new UploadError('INVALID_REQUEST', 'The request path is not valid URL encoding.');
    }
  }

  async function authorise(request: Request): Promise<UploadContext> {
    if (!options.authorize) return { namespace: ANONYMOUS_NAMESPACE };
    let ctx: UploadContext | null;
    try {
      ctx = await options.authorize(request);
    } catch (err) {
      if (err instanceof UploadError) throw err;
      throw new UploadError('UNAUTHORIZED', 'Not authorised to upload.');
    }
    if (!ctx || typeof ctx.namespace !== 'string' || ctx.namespace.length === 0) {
      throw new UploadError('UNAUTHORIZED', 'Not authorised to upload.');
    }
    return ctx;
  }

  function wrap(route: (request: Request, segments: string[], ctx: UploadContext) => Promise<Response>): RouteHandler {
    return async (request) => {
      try {
        const segments = segmentsOf(request);
        const ctx = await authorise(request);
        return await route(request, segments, ctx);
      } catch (err) {
        if (err instanceof UploadError) {
          if (err.status >= 500) reportError(err, request);
          return errorResponse(err);
        }
        if (err instanceof StoragePathError) {
          return errorResponse(new UploadError('INVALID_REQUEST', err.message));
        }
        reportError(err, request);
        return json({ error: { code: 'INTERNAL', message: 'The upload could not be processed.' } }, 500);
      }
    };
  }

  const notFound = (method: string) =>
    new UploadError('NOT_FOUND', `${method} is not supported on this upload path.`);

  return {
    uploader,

    POST: wrap(async (request, segments, ctx) => {
      if (segments.length === 0) {
        const body = await readJson(request, maxJsonBytes);
        const { session, created } = await uploader.begin(ctx, {
          fileName: body.fileName as string,
          totalBytes: body.totalBytes as number,
          fingerprint: body.fingerprint as string,
          metadata: body.metadata as never,
          ...(body.contentType !== undefined ? { contentType: body.contentType as string } : {}),
        });
        return json(sessionView(session, uploader.config().maxFileBytes), created ? 201 : 200);
      }
      if (segments.length === 2 && segments[1] === 'complete') {
        return json(await uploader.complete(ctx, segments[0] as string), 201);
      }
      throw notFound('POST');
    }),

    GET: wrap(async (_request, segments, ctx) => {
      const { maxFileBytes, allowedTypes } = uploader.config();
      if (segments.length === 0) {
        const sessions = await uploader.list(ctx);
        // allowedTypes uses the `accept` attribute's syntax, so a page can pass
        // it straight to <input type="file" accept={allowedTypes.join(',')}>.
        return json({ uploads: sessions.map((s) => sessionView(s, maxFileBytes)), maxFileBytes, allowedTypes });
      }
      if (segments.length === 1) {
        return json(sessionView(await uploader.status(ctx, segments[0] as string), maxFileBytes));
      }
      throw notFound('GET');
    }),

    PUT: wrap(async (request, segments, ctx) => {
      if (segments.length !== 3 || segments[1] !== 'parts') throw notFound('PUT');
      // Strict: '1e3', '+1', ' 1' and '0x10' all coerce to something plausible
      // with Number(), and an index the server could never produce must not
      // reach storage.
      const rawIndex = segments[2] as string;
      if (!/^[0-9]{1,6}$/.test(rawIndex)) {
        throw new UploadError('PART_OUT_OF_RANGE', `"${rawIndex}" is not a valid part number.`);
      }
      const fingerprint = request.headers.get(FINGERPRINT_HEADER);
      if (!fingerprint) throw new UploadError('INVALID_REQUEST', `Missing ${FINGERPRINT_HEADER} header.`);
      const checksum = request.headers.get(PART_CHECKSUM_HEADER);
      if (checksum !== null && !/^[0-9a-f]{64}$/.test(checksum)) {
        throw new UploadError('INVALID_REQUEST', `${PART_CHECKSUM_HEADER} must be a lowercase hex SHA-256.`);
      }

      // Capped at the largest part ANY manifest can have, not the current
      // setting: a part size lowered mid-upload must not reject the parts of an
      // upload that began under the old one. The exact size is checked next.
      const bytes = await readBodyCapped(request, MAX_PART_BYTES, 'Part');
      return json(
        await uploader.putPart(ctx, {
          uploadId: segments[0] as string,
          index: Number(rawIndex),
          bytes,
          fingerprint,
          ...(checksum !== null ? { sha256: checksum } : {}),
        }),
      );
    }),

    DELETE: wrap(async (_request, segments, ctx) => {
      if (segments.length !== 1) throw notFound('DELETE');
      await uploader.discard(ctx, segments[0] as string);
      return new Response(null, { status: 204, headers: NO_STORE });
    }),
  };
}
