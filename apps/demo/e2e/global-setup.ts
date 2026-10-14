import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { FIXTURES, FIXTURE_DIR, type FixtureKey, fixturePath, patternBytes } from './fixtures';

export default function globalSetup(): void {
  // A clean store each run, so a resume is only ever a resume of THIS run.
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  (Object.keys(FIXTURES) as FixtureKey[]).forEach((key, i) => {
    const path = fixturePath(key);
    mkdirSync(dirname(path), { recursive: true });
    // A distinct seed per fixture, so same-named files have different bytes.
    writeFileSync(path, patternBytes(FIXTURES[key].size, i + 3));
  });
}
