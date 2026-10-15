// ---------------------------------------------------------------------------
// file-types.test.ts — the `allowedTypes` option, end to end on the server
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. A disallowed file is refused BEFORE any byte is sent when
// its declared type is wrong, and refused BEFORE it is stored when its content
// is wrong — the renamed executable. Allowed files still complete, and report
// the type their content really is. Every refusal asserts the code, the exact
// message the person reads, and that nothing was stored.
// ---------------------------------------------------------------------------

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UploadClientError } from '../src/client/errors.js';
import { fetchPartSender } from '../src/client/transport.js';
import { startUpload } from '../src/client/upload.js';
import { UploadError } from '../src/core/errors.js';
import { FILE_TYPES } from '../src/core/file-type-presets.js';
import { manifestKey } from '../src/core/layout.js';
import { resolveConfig } from '../src/server/config.js';
import { namespaceKeyFor } from '../src/server/namespace.js';
import { createUploadRoutes } from '../src/server/routes.js';
import { createUploader, type Uploader, type UploaderOptions } from '../src/server/uploader.js';
import { MIB, clearEnv, partOf, patternBytes, tempRoot } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: root, cleanup } = await tempRoot());
  clearEnv();
  process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
});
afterEach(async () => {
  clearEnv();
  await cleanup();
});

const ALICE = { namespace: 'user-alice' };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const EXE = [0x4d, 0x5a, 0x90, 0x00]; // "MZ"
const PDF = Array.from('%PDF-1.7', (c) => c.charCodeAt(0));

/** Offset-dependent bytes, starting with a format's signature. */
function fileBytes(signature: readonly number[], size = 2 * MIB + 99): Uint8Array<ArrayBuffer> {
  const bytes = patternBytes(size);
  bytes.set(signature);
  return bytes;
}

function textBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function uploaderWith(extra: UploaderOptions = {}): Uploader {
  return createUploader({ dir: root, sweepOnBegin: false, ...extra });
}

/** Begin, send every part, complete — returning what complete returned or threw. */
async function upload(up: Uploader, fileName: string, bytes: Uint8Array<ArrayBuffer>, contentType?: string) {
  const fingerprint = `${bytes.byteLength}-1-${fileName.length}`;
  const begun = await up.begin(ALICE, { fileName, totalBytes: bytes.byteLength, fingerprint, contentType });
  const { uploadId, partCount } = begun.session.manifest;
  for (let index = 1; index <= partCount; index += 1) {
    await up.putPart(ALICE, { uploadId, index, bytes: partOf(bytes, index, MIB), fingerprint });
  }
  return { uploadId, outcome: await up.complete(ALICE, uploadId).catch((err: unknown) => err) };
}

async function storedFiles(): Promise<string[]> {
  return readdir(join(root, 'files', namespaceKeyFor(ALICE.namespace))).catch(() => []);
}

describe('allowedTypes configuration — parameter first, .env as the fallback', () => {
  it('reads a comma-separated list from MULTIPART_UPLOAD_ALLOWED_TYPES, lowercased', () => {
    process.env.MULTIPART_UPLOAD_ALLOWED_TYPES = ' Image/*, application/pdf ,.ZIP ';
    expect(resolveConfig().allowedTypes).toEqual(['image/*', 'application/pdf', '.zip']);
  });

  it('the parameter wins over .env, and [] allows every type even when .env is set', () => {
    process.env.MULTIPART_UPLOAD_ALLOWED_TYPES = 'image/*';
    expect(resolveConfig({ allowedTypes: ['application/pdf'] }).allowedTypes).toEqual(['application/pdf']);
    expect(resolveConfig({ allowedTypes: [] }).allowedTypes).toEqual([]);
  });

  it('defaults to every type allowed', () => {
    expect(resolveConfig().allowedTypes).toEqual([]);
  });

  it('refuses a malformed entry, naming the setting and the entry', () => {
    process.env.MULTIPART_UPLOAD_ALLOWED_TYPES = 'image/*,pdf';
    expect(() => resolveConfig()).toThrow(/MULTIPART_UPLOAD_ALLOWED_TYPES has an invalid entry "pdf"/);
    expect(() => resolveConfig({ allowedTypes: ['images'] })).toThrow(/Option allowedTypes has an invalid entry "images"/);
  });
});

describe('check 1 — the declared type, when the upload begins', () => {
  it('refuses a disallowed type with 415 and the allowed list, writing nothing', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*', 'application/pdf'] });
    const err = await up
      .begin(ALICE, { fileName: 'notes.txt', totalBytes: 100, fingerprint: 'fp', contentType: 'text/plain' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((err as UploadError).status).toBe(415);
    expect((err as UploadError).message).toBe(
      '"notes.txt" is not an allowed file type (text/plain). Allowed types: image/*, application/pdf.',
    );
    expect((err as UploadError).details).toEqual({ allowedTypes: ['image/*', 'application/pdf'], declaredType: 'text/plain' });
    expect(await readdir(root)).toEqual([]);
  });

  it('accepts by wildcard, by exact type, and by extension', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*', 'application/pdf', '.zip'] });
    const begin = (fileName: string, contentType: string) =>
      up.begin(ALICE, { fileName, totalBytes: 100, fingerprint: 'fp', contentType });
    expect((await begin('a.webp', 'image/webp')).created).toBe(true);
    expect((await begin('b.pdf', 'application/pdf')).created).toBe(true);
    // Windows reports .zip as application/x-zip-compressed; the extension entry still matches.
    expect((await begin('c.zip', 'application/x-zip-compressed')).created).toBe(true);
  });

  it("uses the extension's usual type when the browser reports none, and stores what was declared", async () => {
    const up = uploaderWith({ allowedTypes: ['application/pdf'] });
    const begun = await up.begin(ALICE, { fileName: 'scan.PDF', totalBytes: 100, fingerprint: 'fp', contentType: '' });
    expect(begun.session.manifest.contentType).toBe('application/pdf');
  });
});

describe('check 2 — the real content, before the file is stored', () => {
  it('stores a genuine PNG and reports its type to onComplete and the client', async () => {
    let seenType = '';
    const up = uploaderWith({ allowedTypes: ['image/*'], onComplete: ({ file }) => void (seenType = file.contentType) });
    const { outcome } = await upload(up, 'photo.png', fileBytes(PNG), 'image/png');
    expect(outcome).toMatchObject({ contentType: 'image/png', fileName: 'photo.png' });
    expect(seenType).toBe('image/png');
    expect(await storedFiles()).toHaveLength(1);
  });

  it('refuses a Windows executable renamed to .png, stores nothing, and keeps the parts', async () => {
    // MUTATION: skip assertContentAllowed in complete -> this resolves and stores the executable.
    const up = uploaderWith({ allowedTypes: ['image/*'] });
    const { uploadId, outcome } = await upload(up, 'photo.png', fileBytes(EXE), 'image/png');
    expect((outcome as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((outcome as UploadError).message).toBe(
      '"photo.png" was refused: its content is a Windows executable, not image/png. Allowed types: image/*.',
    );
    expect((outcome as UploadError).details).toMatchObject({ declaredType: 'image/png', detectedType: 'application/x-msdownload' });
    expect(await storedFiles()).toEqual([]);
    expect((await up.status(ALICE, uploadId)).complete).toBe(true); // parts kept
  });

  it('refuses a file that declares a signed format but has no signature', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*'] });
    const { outcome } = await upload(up, 'photo.png', patternBytes(MIB + 5), 'image/png');
    expect((outcome as UploadError).message).toBe(
      '"photo.png" was refused: it is declared as image/png, but its content is not a valid image/png file. ' +
        'Allowed types: image/*.',
    );
  });

  it('refuses a ZIP archive renamed to .png', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*'] });
    const { outcome } = await upload(up, 'photo.png', fileBytes(ZIP), 'image/png');
    expect((outcome as UploadError).message).toContain('its content is a ZIP archive, not image/png');
  });

  it('stores a JPEG that was named .png when images are allowed, reporting image/jpeg', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*'] });
    const { outcome } = await upload(up, 'photo.png', fileBytes(JPEG), 'image/png');
    expect(outcome).toMatchObject({ contentType: 'image/jpeg' });
  });

  it('stores a .docx, whose content is a ZIP archive, and reports it as the .docx type', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const up = uploaderWith({ allowedTypes: ['.docx'] });
    const { outcome } = await upload(up, 'report.docx', fileBytes(ZIP), docx);
    expect(outcome).toMatchObject({ contentType: docx });
  });

  it('stores a CSV, which has no signature, on its declared type alone', async () => {
    const up = uploaderWith({ allowedTypes: ['text/csv'] });
    const { outcome } = await upload(up, 'people.csv', textBytes('name,email\nada,ada@example.com\n'), 'text/csv');
    expect(outcome).toMatchObject({ contentType: 'text/csv' });
  });

  it('stores a real CSV that Windows reports as application/vnd.ms-excel, as text/csv', async () => {
    // Windows with Excel installed labels every .csv as an Excel file. A policy
    // of ['text/csv'] must still accept a genuine CSV.
    // MUTATION: drop the extension-type branch of declarationAllowed -> 415 at begin.
    const up = uploaderWith({ allowedTypes: ['text/csv'] });
    const { outcome } = await upload(up, 'people.csv', textBytes('name,email\nada,ada@example.com\n'), 'application/vnd.ms-excel');
    expect(outcome).toMatchObject({ contentType: 'text/csv' });
  });

  it('still refuses an executable named .csv and labelled as Excel', async () => {
    const up = uploaderWith({ allowedTypes: ['text/csv'] });
    const { outcome } = await upload(up, 'people.csv', fileBytes(EXE), 'application/vnd.ms-excel');
    expect((outcome as UploadError).message).toContain('its content is a Windows executable');
  });

  it('applies the CURRENT policy at complete, not the one in force at begin', async () => {
    const up = uploaderWith(); // reads .env on every call
    const bytes = fileBytes(PDF, MIB + 1);
    const fingerprint = `${bytes.byteLength}-1-8`;
    const begun = await up.begin(ALICE, { fileName: 'scan.pdf', totalBytes: bytes.byteLength, fingerprint });
    const id = begun.session.manifest.uploadId;
    for (const index of [1, 2]) {
      await up.putPart(ALICE, { uploadId: id, index, bytes: partOf(bytes, index, MIB), fingerprint });
    }
    process.env.MULTIPART_UPLOAD_ALLOWED_TYPES = 'image/*';
    const err = await up.complete(ALICE, id).catch((e: unknown) => e);
    expect((err as UploadError).message).toBe(
      '"scan.pdf" was refused: its content is a PDF document, not application/pdf. Allowed types: image/*.',
    );
  });

  it('completes an upload begun before 0.2.0, whose manifest has no contentType', async () => {
    const up = uploaderWith({ allowedTypes: ['image/*'] });
    const bytes = fileBytes(PNG, MIB + 1);
    const fingerprint = `${bytes.byteLength}-1-9`;
    const begun = await up.begin(ALICE, { fileName: 'photo.png', totalBytes: bytes.byteLength, fingerprint, contentType: 'image/png' });
    const id = begun.session.manifest.uploadId;
    const path = join(root, manifestKey(namespaceKeyFor(ALICE.namespace), id));
    const { contentType: _dropped, ...legacy } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify(legacy));
    for (const index of [1, 2]) await up.putPart(ALICE, { uploadId: id, index, bytes: partOf(bytes, index, MIB), fingerprint });
    expect(await up.complete(ALICE, id)).toMatchObject({ contentType: 'image/png' });
  });

  it('with no allow-list, stores anything and still reports the detected type', async () => {
    const up = uploaderWith();
    const { outcome } = await upload(up, 'setup.png', fileBytes(EXE), 'image/png');
    expect(outcome).toMatchObject({ contentType: 'application/x-msdownload' });
  });
});

describe('FILE_TYPES presets', () => {
  // Protects the presets as configuration: every entry must pass the same
  // validation as a hand-written list, or `allowedTypes: [...FILE_TYPES.x]`
  // would fail at startup.
  it('every preset is a valid allowedTypes list', () => {
    for (const [name, list] of Object.entries(FILE_TYPES)) {
      expect(resolveConfig({ allowedTypes: list }).allowedTypes, name).toEqual([...list]);
    }
  });

  it('images verify by content: a renamed executable is refused, a PNG is stored', async () => {
    const up = uploaderWith({ allowedTypes: [...FILE_TYPES.images] });
    expect((await upload(up, 'a.png', fileBytes(PNG), 'image/png')).outcome).toMatchObject({ contentType: 'image/png' });
    expect(((await upload(up, 'b.png', fileBytes(EXE), 'image/png')).outcome as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('documents accept a .docx and refuse a .txt at begin', async () => {
    const up = uploaderWith({ allowedTypes: [...FILE_TYPES.documents] });
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect((await upload(up, 'r.docx', fileBytes(ZIP), docx)).outcome).toMatchObject({ contentType: docx });
    const err = await up.begin(ALICE, { fileName: 'n.txt', totalBytes: 5, fingerprint: 'fp', contentType: 'text/plain' }).catch((e: unknown) => e);
    expect((err as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
  });
});

describe('over HTTP and through the browser client', () => {
  const routes = () =>
    createUploadRoutes({ dir: root, sweepOnBegin: false, allowedTypes: ['image/*', '.pdf'], authorize: () => ALICE });
  const dispatchTo = (server: ReturnType<typeof routes>): typeof fetch => async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    return server[request.method as 'GET' | 'POST' | 'PUT' | 'DELETE'](request);
  };

  it('lists the allowed types, ready for an <input accept> attribute', async () => {
    const body = await (await routes().GET(new Request('http://localhost/api/uploads'))).json();
    expect(body.allowedTypes).toEqual(['image/*', '.pdf']);
  });

  it('the client sends File.type, and a refused type fails before any part is sent', async () => {
    const dispatch = dispatchTo(routes());
    let parts = 0;
    const file = new File([textBytes('just text')], 'notes.txt', { type: 'text/plain', lastModified: 1 });
    const err = await startUpload({
      file,
      fetch: dispatch,
      sendPart: async (req) => {
        parts += 1;
        return fetchPartSender(dispatch)(req);
      },
    }).promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadClientError);
    expect((err as UploadClientError).code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((err as UploadClientError).status).toBe(415);
    expect(parts).toBe(0);
  });

  it('the client uploads an allowed image and receives its content type', async () => {
    const dispatch = dispatchTo(routes());
    const file = new File([fileBytes(PNG, MIB + 7)], 'photo.png', { type: 'image/png', lastModified: 1 });
    const result = await startUpload({ file, fetch: dispatch, sendPart: fetchPartSender(dispatch) }).promise;
    expect(result.contentType).toBe('image/png');
  });
});
