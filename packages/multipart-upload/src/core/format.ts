// ---------------------------------------------------------------------------
// format.ts — byte counts as people read them, for user-facing messages
// ---------------------------------------------------------------------------
//
// Binary units (1 MB = 1024 × 1024 bytes) with the familiar KB/MB/GB labels —
// the convention file pickers and operating systems show, and the one the demo
// uses for its "Maximum upload size" hint, so the two always agree.
// ---------------------------------------------------------------------------

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** "181 MB", "40 MB", "1.5 GB", "512 B". One decimal below 10, none above. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${UNITS[unit]}`;
}

/** "181 MB (189,963,874 bytes)" — readable, with the exact count kept. */
export function describeByteSize(bytes: number): string {
  return `${formatByteSize(bytes)} (${bytes.toLocaleString('en-US')} bytes)`;
}
