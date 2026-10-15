// ---------------------------------------------------------------------------
// file-signatures.ts — what a file IS, from its first bytes; what it CLAIMS, from its name
// ---------------------------------------------------------------------------
//
// A browser's `File.type` comes from the file's extension, which the person
// uploading controls: `setup.exe` renamed to `photo.png` reports `image/png`.
// The first bytes of a file ("magic numbers") are what the format itself
// writes, so they are what `allowedTypes` is ultimately checked against.
//
// ONLY UNAMBIGUOUS SIGNATURES ARE LISTED. A short or common prefix would turn
// ordinary files into false refusals: BMP's "BM" or a bare MPEG frame sync also
// begin plenty of text and UTF-16 files, so BMP is not detected and MP3 frames
// are matched only in their Layer III form. Text formats (CSV, JSON, SVG, plain
// text) have no signature at all; for those, only the declared type can be
// checked, and the documentation says so.
// ---------------------------------------------------------------------------

export interface DetectedFileType {
  /** The canonical MIME type of the content. */
  readonly mime: string;
  /** Human wording for messages: "a Windows executable". */
  readonly label: string;
}

/** Bytes needed to recognise every signature below (RIFF/ftyp read up to 12). */
export const SIGNATURE_BYTES = 16;

function bytesAt(head: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (head.length < offset + expected.length) return false;
  return expected.every((byte, i) => head[offset + i] === byte);
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  return bytesAt(head, offset, Array.from(text, (ch) => ch.charCodeAt(0)));
}

function asciiSlice(head: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...head.subarray(start, Math.min(end, head.length)));
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/** The type the content actually is, or null when no listed signature matches. */
export function detectFileType(head: Uint8Array): DetectedFileType | null {
  if (bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', label: 'a PNG image' };
  if (bytesAt(head, 0, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', label: 'a JPEG image' };
  if (asciiAt(head, 0, 'GIF87a') || asciiAt(head, 0, 'GIF89a')) return { mime: 'image/gif', label: 'a GIF image' };
  if (asciiAt(head, 0, 'RIFF')) {
    if (asciiAt(head, 8, 'WEBP')) return { mime: 'image/webp', label: 'a WebP image' };
    if (asciiAt(head, 8, 'WAVE')) return { mime: 'audio/wav', label: 'a WAV audio file' };
    if (asciiAt(head, 8, 'AVI ')) return { mime: 'video/x-msvideo', label: 'an AVI video' };
  }
  if (asciiAt(head, 4, 'ftyp') && head.length >= 12) {
    const brand = asciiSlice(head, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', label: 'an AVIF image' };
    if (HEIC_BRANDS.has(brand)) return { mime: 'image/heic', label: 'a HEIC image' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', label: 'a QuickTime video' };
    if (brand === 'M4A ' || brand === 'M4B ') return { mime: 'audio/mp4', label: 'an M4A audio file' };
    return { mime: 'video/mp4', label: 'an MP4 video' };
  }
  if (bytesAt(head, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesAt(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mime: 'image/tiff', label: 'a TIFF image' };
  }
  if (bytesAt(head, 0, [0x00, 0x00, 0x01, 0x00])) return { mime: 'image/x-icon', label: 'an icon file' };
  if (asciiAt(head, 0, '%PDF-')) return { mime: 'application/pdf', label: 'a PDF document' };
  if (bytesAt(head, 0, [0x50, 0x4b, 0x03, 0x04]) || bytesAt(head, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return { mime: 'application/zip', label: 'a ZIP archive' };
  }
  if (bytesAt(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: 'application/x-ole-storage', label: 'a legacy Microsoft Office document' };
  }
  if (bytesAt(head, 0, [0x1f, 0x8b])) return { mime: 'application/gzip', label: 'a gzip archive' };
  if (bytesAt(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: 'application/x-7z-compressed', label: 'a 7-Zip archive' };
  if (asciiAt(head, 0, 'Rar!') && bytesAt(head, 4, [0x1a, 0x07])) return { mime: 'application/vnd.rar', label: 'a RAR archive' };
  if (asciiAt(head, 0, 'OggS')) return { mime: 'audio/ogg', label: 'an Ogg audio file' };
  if (asciiAt(head, 0, 'fLaC')) return { mime: 'audio/flac', label: 'a FLAC audio file' };
  if (bytesAt(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', label: 'a WebM or Matroska video' };
  if (asciiAt(head, 0, 'ID3')) return { mime: 'audio/mpeg', label: 'an MP3 audio file' };
  if (head.length >= 2 && head[0] === 0xff) {
    const second = head[1] as number;
    // ADTS AAC: 1111 0xx1. MPEG audio Layer III: 111x x01x. A UTF-16 BOM
    // (FF FE) is excluded by the layer bits, which is why only Layer III counts.
    if ((second & 0xf6) === 0xf0) return { mime: 'audio/aac', label: 'an AAC audio file' };
    if ((second & 0xe0) === 0xe0 && (second & 0x06) === 0x02) return { mime: 'audio/mpeg', label: 'an MP3 audio file' };
  }
  if (bytesAt(head, 0, [0x00, 0x61, 0x73, 0x6d])) return { mime: 'application/wasm', label: 'a WebAssembly module' };
  if (asciiAt(head, 0, 'MZ')) return { mime: 'application/x-msdownload', label: 'a Windows executable' };
  if (bytesAt(head, 0, [0x7f, 0x45, 0x4c, 0x46])) return { mime: 'application/x-elf', label: 'a Linux executable' };
  if (
    bytesAt(head, 0, [0xfe, 0xed, 0xfa, 0xce]) ||
    bytesAt(head, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
    bytesAt(head, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
    bytesAt(head, 0, [0xcf, 0xfa, 0xed, 0xfe]) ||
    bytesAt(head, 0, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return { mime: 'application/x-mach-binary', label: 'a compiled program' };
  }
  return null;
}

/**
 * Declared types that are the SAME content as a detected type. A .docx is a ZIP
 * archive on disk, an .m4a is an MP4 container, `image/jpg` is a common alias:
 * declaring any of these and having that content is consistent, not a lie.
 */
const SAME_CONTENT: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/heic': ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
  'image/x-icon': ['image/x-icon', 'image/vnd.microsoft.icon'],
  'audio/wav': ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  'audio/mpeg': ['audio/mpeg', 'audio/mp3'],
  'audio/aac': ['audio/aac', 'audio/x-aac'],
  'audio/ogg': ['audio/ogg', 'audio/opus', 'video/ogg', 'application/ogg'],
  'audio/flac': ['audio/flac', 'audio/x-flac'],
  'audio/mp4': ['audio/mp4', 'audio/x-m4a', 'video/mp4'],
  'video/mp4': ['video/mp4', 'video/x-m4v', 'audio/mp4', 'audio/x-m4a', 'application/mp4'],
  'video/webm': ['video/webm', 'audio/webm', 'video/x-matroska', 'audio/x-matroska'],
  'video/x-msvideo': ['video/x-msvideo', 'video/avi'],
  'application/gzip': ['application/gzip', 'application/x-gzip'],
  'application/vnd.rar': ['application/vnd.rar', 'application/x-rar-compressed'],
  'application/zip': [
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/epub+zip',
    'application/java-archive',
    'application/vnd.android.package-archive',
  ],
  'application/x-ole-storage': ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'],
  'application/x-msdownload': ['application/x-msdownload', 'application/vnd.microsoft.portable-executable', 'application/x-dosexec'],
};

/** Every declared type that content with this detected type may honestly claim. */
export function sameContentTypes(detectedMime: string): readonly string[] {
  return SAME_CONTENT[detectedMime] ?? [detectedMime];
}

const SIGNED_TYPES = new Set<string>([
  ...Object.values(SAME_CONTENT).flat(),
  'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/tiff', 'video/quicktime',
  'application/pdf', 'application/x-7z-compressed', 'application/wasm',
  'application/x-elf', 'application/x-mach-binary',
]);

/**
 * True when files of this declared type always start with a signature
 * `detectFileType` recognises — so a file DECLARING it but carrying no
 * recognisable signature is lying about what it is.
 */
export function hasKnownSignature(mime: string): boolean {
  return SIGNED_TYPES.has(mime);
}

const TYPE_FOR_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  ico: 'image/x-icon', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', ogv: 'video/ogg', opus: 'audio/opus', flac: 'audio/flac',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', exe: 'application/x-msdownload', dll: 'application/x-msdownload',
  wasm: 'application/wasm',
};

/** The usual MIME type for a file extension (without the dot), or undefined. */
export function typeForExtension(extension: string): string | undefined {
  return TYPE_FOR_EXTENSION[extension.toLowerCase()];
}
