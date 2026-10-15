// ---------------------------------------------------------------------------
// md5.ts — MD5 of a part, for Azure direct transfer (RFC 1321)
// ---------------------------------------------------------------------------
//
// Azure verifies each block it receives against a Content-MD5 header; it has no
// SHA-256 check. The browser's Web Crypto API offers SHA-256 but not MD5, so a
// small implementation is included rather than a dependency. MD5 is used here
// ONLY as a transport-integrity check that Azure itself performs — never as a
// security boundary (the SAS signature and the server-side checks are).
// Verified against Node's crypto MD5 across lengths in the test suite.
// ---------------------------------------------------------------------------

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** Raw 16-byte MD5 digest of `input`. */
export function md5(input: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const length = bytes.byteLength;
  // Message + 0x80 + zero padding to 56 mod 64, then the bit length (64-bit LE).
  const padded = new Uint8Array(((length + 8) >>> 6) * 64 + 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Array<number>(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = view.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + (K[i] as number) + (m[g] as number)) >>> 0, SHIFTS[(i >> 4) * 4 + (i % 4)] as number)) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** Base64 MD5, as Azure's Content-MD5 header expects. */
export function md5Base64(input: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const byte of md5(input)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
