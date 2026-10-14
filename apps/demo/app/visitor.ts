// The demo's stand-in for a signed-in user: a visitor id kept in a cookie.
//
// Used on the server by the upload route's `authorize`, and in the browser to
// create the id on first visit. A real application has no need for this — it
// uses its own user id.

export const DEMO_VISITOR_COOKIE = 'demo_visitor';

/** Only ids this module could have issued; anything else is treated as absent. */
const VISITOR_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The visitor id in a Cookie header, or null when there is no valid one. */
export function readVisitorId(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === DEMO_VISITOR_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return VISITOR_ID.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * Browser only: return this visitor's id, creating it on the first visit.
 *
 * Random on purpose — it identifies a PERSON, not an upload. Upload names stay
 * fully derived. `crypto.randomUUID` needs a secure context, so plain-HTTP
 * intranet hosts fall back to a time-and-random id.
 */
export function ensureVisitorId(): string {
  const existing = readVisitorId(document.cookie);
  if (existing) return existing;
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  document.cookie = `${DEMO_VISITOR_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
  return id;
}
