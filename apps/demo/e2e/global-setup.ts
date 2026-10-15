import { mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { detectFileType } from '@mr_innovations/multipart-upload/server';

import { prepareCloudStorage } from './cloud-setup';
import { FIXTURES, FIXTURE_DIR, type FixtureKey, fixtureBytes, fixturePath } from './fixtures';

export default async function globalSetup(): Promise<void> {
  await prepareCloudStorage('http://localhost:3100');
  // A clean store each run, so a resume is only ever a resume of THIS run.
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  (Object.keys(FIXTURES) as FixtureKey[]).forEach((key, i) => {
    const path = fixturePath(key);
    mkdirSync(dirname(path), { recursive: true });
    // A distinct seed per fixture, so same-named files have different bytes.
    const bytes = fixtureBytes(key, i + 3);
    // Pattern bytes that happened to begin with a real signature (say 1F 8B,
    // gzip) would be refused by the server's content check, failing an
    // unrelated test for a reason nobody would guess. Fail here, clearly.
    const detected = detectFileType(bytes.subarray(0, 16));
    if (!('signature' in FIXTURES[key]) && detected) {
      throw new Error(`Fixture "${key}" accidentally starts with a ${detected.mime} signature; change its seed.`);
    }
    writeFileSync(path, bytes);
    // Extend to the full size without generating it: the filesystem fills the
    // rest with zeros. Asserted, because a short file would pass the size test
    // for the wrong reason.
    const fixture: { size: number; extendTo?: true } = FIXTURES[key];
    if (fixture.extendTo) {
      truncateSync(path, fixture.size);
      if (statSync(path).size !== fixture.size) throw new Error(`Fixture "${key}" was not extended to ${fixture.size} bytes.`);
    }
  });
}
