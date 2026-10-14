// ---------------------------------------------------------------------------
// config.test.ts — the .env contract, including the configurable maximum size
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The maximum upload size and part size come from .env.
// A value that is silently clamped or mis-parsed runs a limit nobody set, so
// invalid values must throw — naming the variable — and a changed value must
// take effect without reloading the module.
// ---------------------------------------------------------------------------

import { isAbsolute } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UploadError } from '../src/core/errors.js';
import { resolveConfig } from '../src/server/config.js';
import { MIB, clearEnv } from './helpers.js';

afterEach(clearEnv);

describe('defaults', () => {
  it('are 500 MiB max, 2 MiB parts, ./uploads, 48 h, single instance', () => {
    const cfg = resolveConfig();
    expect(cfg.maxFileBytes).toBe(524_288_000); // 500 MiB — must match README and .env.example
    expect(cfg.partBytes).toBe(2 * MIB);
    expect(cfg.partTtlMs).toBe(48 * 3_600_000);
    expect(cfg.instanceId).toBe('single');
    // Resolved to absolute — the bug fixed in the port was a relative root.
    expect(isAbsolute(cfg.dir)).toBe(true);
    expect(cfg.dir.replace(/\\/g, '/').endsWith('/uploads')).toBe(true);
  });
});

describe('MULTIPART_UPLOAD_MAX_FILE_BYTES', () => {
  it('is read from the environment', () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(10 * MIB);
    expect(resolveConfig().maxFileBytes).toBe(10 * MIB);
  });

  it('is re-read on every call, so a change takes effect without a module reload', () => {
    // MUTATION: capture the value in a module-level constant -> the second
    // assertion still sees 10 MiB.
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(10 * MIB);
    expect(resolveConfig().maxFileBytes).toBe(10 * MIB);
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(20 * MIB);
    expect(resolveConfig().maxFileBytes).toBe(20 * MIB);
  });

  it('REFUSES malformed values, naming the variable', () => {
    for (const bad of ['abc', '0', '-5', '1e9', '0x10', '10.5', '1,000', '10MB']) {
      process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = bad;
      expect(() => resolveConfig(), bad).toThrow(UploadError);
      expect(() => resolveConfig(), bad).toThrow(/MULTIPART_UPLOAD_MAX_FILE_BYTES/);
    }
  });

  it('treats an empty value as unset', () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = '   ';
    expect(resolveConfig().maxFileBytes).toBe(500 * MIB);
  });

  it('refuses a limit that would need more parts than the naming scheme allows', () => {
    process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(1_000_000 * MIB);
    expect(() => resolveConfig()).toThrow(/needs more than 999999 parts/);
  });

  it('can be overridden in code', () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = 'not-a-number';
    // The override wins and the bad variable is never parsed.
    expect(resolveConfig({ maxFileBytes: 5 * MIB }).maxFileBytes).toBe(5 * MIB);
  });
});

describe('MULTIPART_UPLOAD_PART_BYTES', () => {
  it('THROWS outside 1–8 MiB instead of clamping', () => {
    // MUTATION: clamp instead of throw -> 100 silently becomes 1 MiB, and the
    // wrong value is frozen into every manifest.
    for (const bad of ['100', String(9 * MIB)]) {
      process.env.MULTIPART_UPLOAD_PART_BYTES = bad;
      expect(() => resolveConfig(), bad).toThrow(/MULTIPART_UPLOAD_PART_BYTES must be between/);
    }
  });

  it('accepts both ends of the range', () => {
    process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
    expect(resolveConfig().partBytes).toBe(MIB);
    process.env.MULTIPART_UPLOAD_PART_BYTES = String(8 * MIB);
    expect(resolveConfig().partBytes).toBe(8 * MIB);
  });
});

describe('other variables', () => {
  it('reads the TTL in hours, not milliseconds', () => {
    // MUTATION: drop the hour conversion -> a TTL of 1 ms reaps live uploads.
    process.env.MULTIPART_UPLOAD_PART_TTL_HOURS = '1';
    expect(resolveConfig().partTtlMs).toBe(3_600_000);
  });

  it('does not parse the TTL variable when the code overrides it', () => {
    process.env.MULTIPART_UPLOAD_PART_TTL_HOURS = 'garbage';
    expect(resolveConfig({ partTtlMs: 1000 }).partTtlMs).toBe(1000);
  });

  it('reads the storage directory and instance id', () => {
    process.env.MULTIPART_UPLOAD_DIR = './somewhere-else';
    process.env.MULTIPART_UPLOAD_INSTANCE_ID = 'node-b';
    const cfg = resolveConfig();
    expect(cfg.dir.replace(/\\/g, '/').endsWith('/somewhere-else')).toBe(true);
    expect(cfg.instanceId).toBe('node-b');
  });
});
