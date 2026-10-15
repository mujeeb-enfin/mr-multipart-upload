// ---------------------------------------------------------------------------
// file-type-presets.ts — ready-made `allowedTypes` lists
// ---------------------------------------------------------------------------
//
// Combine freely; every entry is valid both as an `allowedTypes` entry and in an
// HTML `accept` attribute:
//
//   allowedTypes: [...FILE_TYPES.images, ...FILE_TYPES.pdf]
//   <input type="file" accept={FILE_TYPES.images.join(',')} />
//
// SVG is deliberately NOT in `images`: an SVG is a document that can carry
// script. Allow it explicitly ('image/svg+xml') only if you never serve uploads
// inline from your own origin.
// ---------------------------------------------------------------------------

const WORD = ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
const EXCEL = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;
const POWERPOINT = [
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
const OPENDOCUMENT = [
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
] as const;

export const FILE_TYPES = {
  /** Photos and raster images — every format here is verified by its content. */
  images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif', 'image/tiff'],
  /** Common web images only: JPEG, PNG, GIF, WebP. */
  webImages: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  pdf: ['application/pdf'],
  word: [...WORD],
  excel: [...EXCEL],
  powerpoint: [...POWERPOINT],
  openDocument: [...OPENDOCUMENT],
  /** PDF, Word, Excel, PowerPoint and OpenDocument files. */
  documents: ['application/pdf', ...WORD, ...EXCEL, ...POWERPOINT, ...OPENDOCUMENT],
  /** Spreadsheets, including CSV (Windows often reports .csv as Excel; both are accepted). */
  spreadsheets: [...EXCEL, 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv'],
  /** Text formats. They have no signature, so only the declared type is checked. */
  text: ['text/plain', 'text/csv', 'text/markdown', 'application/json'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/webm'],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo'],
  /** ZIP (as reported by every browser, including Windows' x-zip-compressed), gzip, 7-Zip, RAR. */
  archives: ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-7z-compressed', 'application/vnd.rar'],
} as const satisfies Record<string, readonly string[]>;

export type FileTypePreset = keyof typeof FILE_TYPES;
