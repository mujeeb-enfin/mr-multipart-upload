// ---------------------------------------------------------------------------
// serve.ts — start `next start` for the e2e suite and keep a copy of its output
// ---------------------------------------------------------------------------
//
// Playwright's webServer only prints the server's output to the runner console,
// where no test can read it. CODER.md requires each test to assert the server
// logged no errors during its own window, so this launcher tees stdout and
// stderr into the file named by MPU_SERVER_LOG; the shared fixture reads the
// part written while a test ran.
//
// Run with `node --experimental-strip-types e2e/serve.ts` (TypeScript only, no
// build step). Next's CLI is started through Node directly rather than via npx,
// so no shell is involved and the same command works on Windows and Linux.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const logPath = process.env.MPU_SERVER_LOG;
const port = process.env.MPU_PORT ?? '3100';
if (!logPath) {
  console.error('serve.ts: MPU_SERVER_LOG must name the log file');
  process.exit(2);
}

mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: 'w' });

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const server = spawn(process.execPath, [nextBin, 'start', '--port', port], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

server.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
server.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

const stop = () => server.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
server.on('exit', (code) => log.end(() => process.exit(code ?? 0)));
