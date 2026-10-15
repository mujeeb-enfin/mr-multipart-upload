// ---------------------------------------------------------------------------
// file-signatures.test.ts — recognising a file's real format from its first bytes
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The content check behind `allowedTypes`. Two failure
// modes matter equally: a format that is NOT recognised lets a renamed file
// through, and a FALSE recognition refuses an ordinary file (a text file read
// as an MP3). Both directions are asserted.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { detectFileType, hasKnownSignature, sameContentTypes, typeForExtension } from '../src/core/file-signatures.js';

function headOf(prefix: readonly number[] | string, padTo = 32): Uint8Array {
  const start = typeof prefix === 'string' ? Array.from(prefix, (c) => c.charCodeAt(0)) : [...prefix];
  const out = new Uint8Array(Math.max(padTo, start.length));
  out.set(start);
  for (let i = start.length; i < out.length; i += 1) out[i] = 0x41; // 'A' filler
  return out;
}

function riff(form: string): number[] {
  return [...Array.from('RIFF', (c) => c.charCodeAt(0)), 0x24, 0, 0, 0, ...Array.from(form, (c) => c.charCodeAt(0))];
}

function ftyp(brand: string): number[] {
  return [0, 0, 0, 0x20, ...Array.from(`ftyp${brand}`, (c) => c.charCodeAt(0))];
}

describe('detectFileType recognises each listed format', () => {
  const cases: Array<[string, readonly number[] | string, string]> = [
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['GIF', 'GIF89a', 'image/gif'],
    ['WebP', riff('WEBP'), 'image/webp'],
    ['WAV', riff('WAVE'), 'audio/wav'],
    ['AVI', riff('AVI '), 'video/x-msvideo'],
    ['MP4', ftyp('isom'), 'video/mp4'],
    ['M4A', ftyp('M4A '), 'audio/mp4'],
    ['MOV', ftyp('qt  '), 'video/quicktime'],
    ['HEIC', ftyp('heic'), 'image/heic'],
    ['AVIF', ftyp('avif'), 'image/avif'],
    ['TIFF', [0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
    ['ICO', [0x00, 0x00, 0x01, 0x00], 'image/x-icon'],
    ['PDF', '%PDF-1.7', 'application/pdf'],
    ['ZIP', [0x50, 0x4b, 0x03, 0x04], 'application/zip'],
    ['legacy Office', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'application/x-ole-storage'],
    ['gzip', [0x1f, 0x8b, 0x08], 'application/gzip'],
    ['7-Zip', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 'application/x-7z-compressed'],
    ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], 'application/vnd.rar'],
    ['Ogg', 'OggS', 'audio/ogg'],
    ['FLAC', 'fLaC', 'audio/flac'],
    ['WebM', [0x1a, 0x45, 0xdf, 0xa3], 'video/webm'],
    ['MP3 with ID3 tag', 'ID3', 'audio/mpeg'],
    ['MP3 Layer III frame', [0xff, 0xfb, 0x90, 0x44], 'audio/mpeg'],
    ['AAC ADTS frame', [0xff, 0xf1, 0x50, 0x80], 'audio/aac'],
    ['WebAssembly', [0x00, 0x61, 0x73, 0x6d], 'application/wasm'],
    ['Windows executable', 'MZ', 'application/x-msdownload'],
    ['Linux executable', [0x7f, 0x45, 0x4c, 0x46], 'application/x-elf'],
    ['macOS executable', [0xcf, 0xfa, 0xed, 0xfe], 'application/x-mach-binary'],
  ];
  for (const [name, prefix, mime] of cases) {
    it(name, () => {
      expect(detectFileType(headOf(prefix))?.mime).toBe(mime);
    });
  }
});

describe('detectFileType does not misread ordinary files', () => {
  // MUTATION: drop the Layer III bit test -> the UTF-16 file reads as an MP3 and
  // every UTF-16 CSV is refused under an allow-list of text types.
  it('plain text, CSV, JSON, SVG, UTF-16 text, "BM…" text and an empty file are not recognised', () => {
    expect(detectFileType(headOf('hello world, this is text'))).toBeNull();
    expect(detectFileType(headOf('name,email\nada,ada@example.com'))).toBeNull();
    expect(detectFileType(headOf('{"a":1}'))).toBeNull();
    expect(detectFileType(headOf('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(detectFileType(headOf([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBeNull();
    expect(detectFileType(headOf('BMW service report'))).toBeNull();
    expect(detectFileType(new Uint8Array(0))).toBeNull();
  });

  it('a signature that is cut off is not recognised', () => {
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
  });
});

describe('format families and extension types', () => {
  it('treats a .docx as the same content as a ZIP archive, and a .m4a as an MP4 container', () => {
    expect(sameContentTypes('application/zip')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(sameContentTypes('video/mp4')).toContain('audio/mp4');
    expect(sameContentTypes('image/png')).toEqual(['image/png']);
  });

  it('knows which declared types must carry a signature, and that text types cannot', () => {
    expect(hasKnownSignature('image/png')).toBe(true);
    expect(hasKnownSignature('application/pdf')).toBe(true);
    expect(hasKnownSignature('text/csv')).toBe(false);
    expect(hasKnownSignature('image/svg+xml')).toBe(false);
  });

  it('maps extensions to their usual type, case-insensitively', () => {
    expect(typeForExtension('PDF')).toBe('application/pdf');
    expect(typeForExtension('jpg')).toBe('image/jpeg');
    expect(typeForExtension('unknownext')).toBeUndefined();
  });
});
