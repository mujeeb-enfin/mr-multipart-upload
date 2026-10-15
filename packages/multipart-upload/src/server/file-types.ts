// ---------------------------------------------------------------------------
// file-types.ts — the `allowedTypes` policy, checked twice
// ---------------------------------------------------------------------------
//
// Entries use the syntax of the HTML `accept` attribute, so one list can drive
// both the server and the file picker:
//
//   'image/png'   one MIME type
//   'image/*'     every subtype
//   '.zip'        an extension
//
// CHECK 1 — at begin, on the DECLARED type (the browser's File.type, or the
// extension's usual type when the browser reports none) and the extension.
// Refused before a single byte is uploaded. This is the user-friendly gate; it
// is NOT a security check, because the declared type comes from the file name.
//
// CHECK 2 — at complete, on the CONTENT. The first bytes are matched against
// known signatures (core/file-signatures.ts). The file passes when its content
// is an allowed type, or is the same format it declared (a .docx is a ZIP). It
// is refused when its content is a different, recognised format — a renamed
// executable — or when it declares a signed format (PNG, PDF, …) but carries no
// signature at all. Formats with no signature (CSV, JSON, plain text, SVG) can
// only be checked by check 1.
// ---------------------------------------------------------------------------

import { UploadError } from '../core/errors.js';
import { detectFileType, hasKnownSignature, sameContentTypes, typeForExtension } from '../core/file-signatures.js';

const MIME_ENTRY = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;
const EXTENSION_ENTRY = /^\.[a-z0-9][a-z0-9+_-]*$/;
const OCTET_STREAM = 'application/octet-stream';

/** Validate and normalise an allow-list. Throws CONFIG_INVALID naming `source`. */
export function normaliseAllowedTypes(entries: readonly unknown[], source: string): string[] {
  return entries.map((entry) => {
    const value = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!MIME_ENTRY.test(value) && !EXTENSION_ENTRY.test(value)) {
      throw new UploadError(
        'CONFIG_INVALID',
        `${source} has an invalid entry ${JSON.stringify(entry)}: use a MIME type ("application/pdf"), ` +
          'a wildcard ("image/*") or an extension (".zip").',
      );
    }
    return value;
  });
}

function extensionOfName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** The browser's type without parameters; the extension's type when it gave none. */
export function declaredTypeFor(fileName: string, contentType: string | undefined): string {
  const reported = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (reported !== '' && reported !== OCTET_STREAM) return reported;
  return typeForExtension(extensionOfName(fileName)) ?? (reported || OCTET_STREAM);
}

/** Does any entry allow this MIME type? Extension entries count via their usual type. */
function allowsType(allowed: readonly string[], mime: string): boolean {
  return allowed.some((entry) => {
    if (entry.startsWith('.')) return typeForExtension(entry.slice(1)) === mime;
    if (entry.endsWith('/*')) return mime.startsWith(entry.slice(0, -1));
    return entry === mime;
  });
}

function allowsExtension(allowed: readonly string[], fileName: string): boolean {
  const extension = extensionOfName(fileName);
  return extension !== '' && allowed.includes(`.${extension}`);
}

/**
 * Is what the file CLAIMS to be allowed? The reported type, the extension, or
 * the extension's usual type. All three come from the uploader, so accepting
 * any of them costs nothing — check 2 is what verifies — while it avoids
 * refusing real files that browsers mislabel: Windows with Excel installed
 * reports every .csv as application/vnd.ms-excel.
 */
function declarationAllowed(allowed: readonly string[], fileName: string, declaredType: string): boolean {
  const byExtension = typeForExtension(extensionOfName(fileName));
  return (
    allowsType(allowed, declaredType) ||
    allowsExtension(allowed, fileName) ||
    (byExtension !== undefined && allowsType(allowed, byExtension))
  );
}

function refusal(message: string, allowed: readonly string[], details: Record<string, unknown>): UploadError {
  return new UploadError('FILE_TYPE_NOT_ALLOWED', `${message} Allowed types: ${allowed.join(', ')}.`, {
    allowedTypes: [...allowed],
    ...details,
  });
}

/** Check 1, at begin. An empty allow-list allows everything. */
export function assertDeclaredTypeAllowed(allowed: readonly string[], fileName: string, declaredType: string): void {
  if (allowed.length === 0) return;
  if (declarationAllowed(allowed, fileName, declaredType)) return;
  throw refusal(`"${fileName}" is not an allowed file type (${declaredType}).`, allowed, { declaredType });
}

/**
 * Check 2, at complete, on the file's first bytes. Returns the type to report
 * for the stored file: the declared type when the content confirms it, the
 * detected type when the content is a different (allowed) format, and the
 * declared type when the format has no signature to check.
 */
export function assertContentAllowed(
  allowed: readonly string[],
  head: Uint8Array,
  fileName: string,
  declaredType: string,
): string {
  const detected = detectFileType(head);
  // An honest declaration is reported as declared: it is the more specific
  // name for the same bytes (a .docx detects as a ZIP archive).
  const honest = detected !== null && sameContentTypes(detected.mime).includes(declaredType);
  if (allowed.length === 0) return detected && !honest ? detected.mime : declaredType;

  if (detected) {
    // The format it said it was, and that declaration is allowed (re-checked
    // here in case the policy changed since begin) — or the content is itself
    // an allowed type (a JPEG named .png under image/*).
    if (honest && declarationAllowed(allowed, fileName, declaredType)) return declaredType;
    if (allowsType(allowed, detected.mime)) return detected.mime;
    throw refusal(
      `"${fileName}" was refused: its content is ${detected.label}, not ${declaredType}.`,
      allowed,
      { declaredType, detectedType: detected.mime },
    );
  }
  // No recognisable signature. A lie only if BOTH the reported type and the
  // extension's type are formats that always carry one: a .csv reported as
  // application/vnd.ms-excel is a real CSV, while a "photo.png" of random bytes
  // is not a PNG.
  const byExtension = typeForExtension(extensionOfName(fileName));
  if (hasKnownSignature(declaredType) && (byExtension === undefined || hasKnownSignature(byExtension))) {
    throw refusal(
      `"${fileName}" was refused: it is declared as ${declaredType}, but its content is not a valid ${declaredType} file.`,
      allowed,
      { declaredType, detectedType: null },
    );
  }
  // Report the extension's type when it is the unsigned (text) format the
  // content is consistent with: text/csv, not the browser's Excel label.
  return byExtension !== undefined && !hasKnownSignature(byExtension) ? byExtension : declaredType;
}
