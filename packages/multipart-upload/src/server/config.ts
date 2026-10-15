// ---------------------------------------------------------------------------
// config.ts — configuration: parameters first, .env as the fallback
// ---------------------------------------------------------------------------
//
// Precedence for every setting: the parameter passed in code, then the .env
// variable, then the default below.
//
//   MULTIPART_UPLOAD_MAX_FILE_BYTES   largest file accepted        default 500 MiB
//   MULTIPART_UPLOAD_PART_BYTES       bytes per part, 1–8 MiB      default 2 MiB
//   MULTIPART_UPLOAD_DIR              storage root                 default ./uploads
//   MULTIPART_UPLOAD_PART_TTL_HOURS   unfinished uploads expire    default 48
//   MULTIPART_UPLOAD_INSTANCE_ID      set per instance if >1       default "single"
//   MULTIPART_UPLOAD_ALLOWED_TYPES    e.g. image/*,application/pdf default: every type
//
// READ ON EVERY CALL, not captured in module constants. A constant is fixed the
// moment the module loads, so neither a changed `.env` (after a restart that
// reuses a warm module) nor a test can override it.
//
// INVALID VALUES THROW, they are never clamped. A silent clamp is how a
// deployment ends up running a limit nobody set — and the part size is frozen
// into every manifest, so a wrong value outlives the misconfiguration. Every
// message names the variable, so the fix is obvious from the error alone.
// ---------------------------------------------------------------------------

import { resolve } from 'node:path';

import { UploadError } from '../core/errors.js';
import { MAX_PART_COUNT } from '../core/layout.js';
import { normaliseAllowedTypes } from './file-types.js';

export const MIB = 1024 * 1024;
export const MIN_PART_BYTES = 1 * MIB;
export const MAX_PART_BYTES = 8 * MIB;

const DEFAULT_MAX_FILE_BYTES = 500 * MIB;
const DEFAULT_PART_BYTES = 2 * MIB;
const DEFAULT_DIR = './uploads';
const DEFAULT_PART_TTL_HOURS = 48;
const DEFAULT_INSTANCE_ID = 'single';

export const ENV = {
  maxFileBytes: 'MULTIPART_UPLOAD_MAX_FILE_BYTES',
  partBytes: 'MULTIPART_UPLOAD_PART_BYTES',
  dir: 'MULTIPART_UPLOAD_DIR',
  partTtlHours: 'MULTIPART_UPLOAD_PART_TTL_HOURS',
  instanceId: 'MULTIPART_UPLOAD_INSTANCE_ID',
  allowedTypes: 'MULTIPART_UPLOAD_ALLOWED_TYPES',
} as const;

/**
 * Settings passed as parameters to `createUploadRoutes()` / `createUploader()`.
 * Each one is used first; when it is left out, the `.env` variable named below
 * is used, and when that is unset too, the built-in default.
 */
export interface ConfigOverrides {
  /** Largest file accepted, in bytes. Falls back to MULTIPART_UPLOAD_MAX_FILE_BYTES, then 500 MiB. */
  maxFileBytes?: number;
  /** Bytes per part, 1–8 MiB. Falls back to MULTIPART_UPLOAD_PART_BYTES, then 2 MiB. */
  partBytes?: number;
  /** Storage folder for parts and finished files. Falls back to MULTIPART_UPLOAD_DIR, then ./uploads. */
  dir?: string;
  /** Unfinished uploads untouched this long are removed, in ms. Falls back to MULTIPART_UPLOAD_PART_TTL_HOURS, then 48 h. */
  partTtlMs?: number;
  /** A distinct value per server when running more than one. Falls back to MULTIPART_UPLOAD_INSTANCE_ID, then "single". */
  instanceId?: string;
  /**
   * File types accepted, in the syntax of the HTML `accept` attribute:
   * `['image/*', 'application/pdf', '.zip']`. Checked by declared type when the
   * upload begins and by actual content before it is stored. Falls back to
   * MULTIPART_UPLOAD_ALLOWED_TYPES (comma-separated), then every type. Pass `[]`
   * to allow every type even when the variable is set.
   */
  allowedTypes?: readonly string[];
}

export interface ResolvedConfig {
  readonly maxFileBytes: number;
  readonly partBytes: number;
  /** Absolute. Resolved once here so every containment check compares like with like. */
  readonly dir: string;
  readonly partTtlMs: number;
  readonly instanceId: string;
  /** Lowercased and validated. Empty: every type is allowed. */
  readonly allowedTypes: readonly string[];
}

function invalid(source: string, message: string): never {
  throw new UploadError('CONFIG_INVALID', `${source} ${message}`);
}

function readPositiveInt(name: string, override: number | undefined, fallback: number): number {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override <= 0) {
      invalid(`Option for ${name}`, `must be a positive integer, got ${override}`);
    }
    return override;
  }
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // Strict: '1e9', '0x10', ' 5', '2097152.5' and '1,000' are all refused rather
  // than coerced into something plausible.
  if (!/^[0-9]+$/.test(raw.trim())) invalid(name, `must be a positive whole number of bytes, got "${raw}"`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) invalid(name, `must be a positive integer, got "${raw}"`);
  return value;
}

/**
 * Resolve the effective configuration. Call per request; it is cheap.
 *
 * Cross-checks the limits against each other, because each can be valid alone
 * and still impossible together: a 2 TB limit at 1 MiB parts needs more parts
 * than the naming scheme can express.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const partBytes = readPositiveInt(ENV.partBytes, overrides.partBytes, DEFAULT_PART_BYTES);
  if (partBytes < MIN_PART_BYTES || partBytes > MAX_PART_BYTES) {
    invalid(ENV.partBytes, `must be between ${MIN_PART_BYTES} (1 MiB) and ${MAX_PART_BYTES} (8 MiB), got ${partBytes}`);
  }

  const maxFileBytes = readPositiveInt(ENV.maxFileBytes, overrides.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  if (Math.ceil(maxFileBytes / partBytes) > MAX_PART_COUNT) {
    invalid(
      ENV.maxFileBytes,
      `(${maxFileBytes}) needs more than ${MAX_PART_COUNT} parts at ${ENV.partBytes}=${partBytes}. ` +
        'Raise the part size or lower the limit.',
    );
  }

  // The env variable is in HOURS, the option in milliseconds; an override means
  // the variable is not read at all, so a bad value in .env cannot fail a
  // deployment that has deliberately replaced it.
  const partTtlMs =
    overrides.partTtlMs ??
    readPositiveInt(ENV.partTtlHours, undefined, DEFAULT_PART_TTL_HOURS) * 60 * 60 * 1000;
  if (!Number.isSafeInteger(partTtlMs) || partTtlMs <= 0) {
    invalid('Option partTtlMs', `must be a positive integer, got ${partTtlMs}`);
  }

  const rawDir = overrides.dir ?? process.env[ENV.dir];
  const dir = resolve(rawDir && rawDir.trim() !== '' ? rawDir.trim() : DEFAULT_DIR);

  const rawInstance = overrides.instanceId ?? process.env[ENV.instanceId];
  const instanceId = rawInstance && rawInstance.trim() !== '' ? rawInstance.trim() : DEFAULT_INSTANCE_ID;
  if (instanceId.length > 128) invalid(ENV.instanceId, 'must be at most 128 characters');

  let allowedTypes: string[];
  if (overrides.allowedTypes !== undefined) {
    if (!Array.isArray(overrides.allowedTypes)) invalid('Option allowedTypes', 'must be an array of strings');
    allowedTypes = normaliseAllowedTypes(overrides.allowedTypes, 'Option allowedTypes');
  } else {
    const rawTypes = process.env[ENV.allowedTypes] ?? '';
    const entries = rawTypes.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    allowedTypes = normaliseAllowedTypes(entries, ENV.allowedTypes);
  }

  return { maxFileBytes, partBytes, dir, partTtlMs, instanceId, allowedTypes };
}
