import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURES, FIXTURE_DIR, patternBytes } from './fixtures';

export default function globalSetup(): void {
  // A clean store each run, so a resume is only ever a resume of THIS run.
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  Object.values(FIXTURES).forEach((fixture, i) => {
    writeFileSync(join(FIXTURE_DIR, fixture.name), patternBytes(fixture.size, i + 3));
  });
}
