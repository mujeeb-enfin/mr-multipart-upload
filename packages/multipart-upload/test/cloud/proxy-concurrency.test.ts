// ---------------------------------------------------------------------------
// proxy-concurrency.test.ts — contention on cloud storage, per backend
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. On aws_s3, minio and azure_blob: exactly one request can
// take over an abandoned complete lock; a complete that stalled past
// lockStaleMs is taken over without running onComplete twice; a commit whose
// response was lost is recognised as the upload's own; a commit S3 cancelled
// (409) restarts the provider session; an object written after a lifecycle
// rule aborted the upload is never taken for its own; two uploads committing
// onto one key at the same moment store exactly one file; a commit never lands
// on an object the upload did not create; and a discard drops the commit marker
// before it aborts the provider session. Races are forced with gates and
// barriers that fail at a deadline instead of hanging.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UploadError } from '../../src/core/errors.js';
import { lockGenerationKey, manifestKey, sessionKey } from '../../src/core/layout.js';
import type { UploadManifest } from '../../src/core/session.js';
import { acquireLock } from '../../src/server/lock.js';
import { namespaceKeyFor } from '../../src/server/namespace.js';
import { createUploader, type Uploader, type UploaderOptions } from '../../src/server/uploader.js';
import { ProviderSessionLostError } from '../../src/storage/cloud/types.js';
import { clearEnv, partOf, patternBytes } from '../helpers.js';
import {
  AVAILABLE,
  CLOUD_PART_BYTES,
  backendFor,
  barrier,
  createBucket,
  deleteBucket,
  openable,
  readAll,
  sha256,
  storageOptions,
  uniqueBucketName,
  type CloudKind,
} from './cloud-helpers.js';

const ALICE = { namespace: 'user-alice' };
const BOB = { namespace: 'user-bob' };
const SIZE = 2 * CLOUD_PART_BYTES + 777; // 3 parts: 5 MiB, 5 MiB, 777 B

const fileOf = (size: number, seed: number) => patternBytes(size, seed);
const partsOf = (size: number) => Array.from({ length: Math.ceil(size / CLOUD_PART_BYTES) }, (_, i) => i + 1);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof UploadError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe.skipIf(AVAILABLE.length === 0)('cloud backends — contention', () => {
  describe.each(AVAILABLE)('%s', (kind: CloudKind) => {
    const bucket = uniqueBucketName(`race-${kind.replace('_', '')}`);
    const base = (extra: UploaderOptions = {}): UploaderOptions => ({
      ...storageOptions(kind, bucket),
      partBytes: CLOUD_PART_BYTES,
      sweepOnBegin: false,
      ...extra,
    });
    const uploader = (extra: UploaderOptions = {}): Uploader => createUploader(base(extra));

    async function sendParts(up: Uploader, ctx: { namespace: string }, id: string, bytes: Uint8Array<ArrayBuffer>, fp: string) {
      for (const index of partsOf(bytes.byteLength)) {
        await up.putPart(ctx, { uploadId: id, index, bytes: partOf(bytes, index, CLOUD_PART_BYTES), fingerprint: fp });
      }
    }

    // 60 s: an emulator serving several test files at once can take longer than
    // the 10 s default to create or delete a bucket / container.
    beforeAll(async () => {
      clearEnv();
      await createBucket(kind, bucket);
    }, 60_000);
    afterAll(async () => {
      await deleteBucket(kind, bucket);
    }, 60_000);

    it('lets exactly one of two requests take over the same abandoned lock', async () => {
      // The lock contract of test/lock.test.ts, on this backend's control store:
      // both read the abandoned lock, the second acts after the first has taken it.
      // MUTATION: the one-name takeover (remove + create the same key) -> both acquire.
      const backend = await backendFor(base());
      const ns = namespaceKeyFor(ALICE.namespace);
      const id = 'c'.repeat(64);
      const control = backend.control;
      try {
        await control.createExclusive(lockGenerationKey(ns, id, 1), 'crashed');
        let readers = 0;
        const bothRead = openable();
        const firstActed = openable();
        const inTurn = Object.assign(Object.create(Object.getPrototypeOf(control)), control, {
          stat: async (key: string) => {
            const info = await control.stat(key);
            if (!key.includes('completing')) return info;
            readers += 1;
            const turn = readers;
            if (turn === 2) bothRead.open();
            await bothRead.wait();
            if (turn === 2) await firstActed.wait();
            return info;
          },
          createExclusive: async (key: string, data: Uint8Array | string) => {
            const outcome = await control.createExclusive(key, data);
            if (key.includes('completing')) firstActed.open();
            return outcome;
          },
        });
        const ctx = { storage: inTurn, namespaceKey: ns } as unknown as Parameters<typeof acquireLock>[0];
        const outcomes = await Promise.all([code(acquireLock(ctx, id, -1)), code(acquireLock(ctx, id, -1))]);
        expect(outcomes.sort()).toEqual(['COMPLETE_IN_PROGRESS', 'resolved']);
      } finally {
        await control.removeTree(sessionKey(ns, id));
      }
    });

    it('a complete that stalls past lockStaleMs after committing is taken over without running onComplete twice', async () => {
      // The stalled request committed, then stopped; a second request takes the
      // lock over and finishes the file. The first, resuming, must stop.
      // MUTATION: drop the lock checks after the commit (refresh/confirm) -> the
      // stalled request records the commit and runs onComplete a second time.
      const calls: string[] = [];
      const onComplete = ({ file }: { file: { key: string } }) => void calls.push(file.key);
      const stalledUploader = uploader({ onComplete });
      const takerUploader = uploader({ onComplete, lockStaleMs: -1 }); // any lock looks abandoned
      const bytes = fileOf(SIZE, 29);
      const begun = await stalledUploader.begin(ALICE, { fileName: 'stall.bin', totalBytes: SIZE, fingerprint: 'fp-stall' });
      const id = begun.session.manifest.uploadId;
      await sendParts(stalledUploader, ALICE, id, bytes, 'fp-stall');

      const backend = await backendFor(base()); // the uploaders' own (cached) backend
      const realCommit = backend.commit;
      const hasCommitted = openable();
      const release = openable();
      let stalledOnce = false;
      Object.assign(backend, {
        commit: async (...args: Parameters<typeof realCommit>) => {
          const result = await realCommit(...args);
          if (!stalledOnce) {
            stalledOnce = true; // only the first commit stalls — a taker that wrongly commits again must not hang
            hasCommitted.open();
            await release.wait(); // stalls AFTER the provider commit
          }
          return result;
        },
      });
      let stalled: Promise<string>;
      let taken: Awaited<ReturnType<Uploader['complete']>>;
      try {
        stalled = code(stalledUploader.complete(ALICE, id));
        await hasCommitted.wait();
        taken = await takerUploader.complete(ALICE, id);
      } finally {
        Object.assign(backend, { commit: realCommit });
        release.open();
      }
      expect(await stalled).toBe('COMPLETE_IN_PROGRESS');
      expect(calls).toEqual([taken.key]);
      expect(sha256(await readAll(backend.openRead(taken.key)))).toBe(sha256(bytes));
      expect(await code(stalledUploader.status(ALICE, id))).toBe('NO_SESSION');
    });

    it('a commit whose response was lost — the SDK retry refused as "key taken" — is recognised as its own', async () => {
      // The provider performed the commit, the response never arrived, and the
      // SDK's automatic retry (conditional on a free key) met this upload's own
      // new object: the provider answers it like a taken key. That must finish
      // the upload, not strand it as DESTINATION_EXISTS with its parts consumed.
      // MUTATION: treat every DESTINATION_EXISTS from the commit as foreign
      // (skip holdsOwnCommit) -> complete fails and the upload cannot finish.
      const calls: string[] = [];
      const up = uploader({ onComplete: ({ file }) => void calls.push(file.key) });
      const bytes = fileOf(SIZE, 32);
      const begun = await up.begin(ALICE, { fileName: 'lost.bin', totalBytes: SIZE, fingerprint: 'fp-lost' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-lost');
      const backend = await backendFor(base());
      const realCommit = backend.commit;
      Object.assign(backend, {
        commit: async (...args: Parameters<typeof realCommit>) => {
          await realCommit(...args); // performed by the provider…
          throw new UploadError('DESTINATION_EXISTS', 'refused'); // …but what came back is the retry's refusal
        },
      });
      let done: Awaited<ReturnType<Uploader['complete']>>;
      try {
        done = await up.complete(ALICE, id);
      } finally {
        Object.assign(backend, { commit: realCommit });
      }
      expect(done).toMatchObject({ size: SIZE });
      expect(calls).toEqual([done.key]);
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
    });

    it.skipIf(kind === 'azure_blob')('a commit cancelled by a concurrent write (S3 409) restarts the provider session, and a resend stores the file', async () => {
      // S3 answers 409 ConditionalRequestConflict when a concurrent write of the
      // key wins, and drops this multipart upload. Nothing was stored, so the
      // upload must stay re-sendable — not fail for good on a dead UploadId.
      // MUTATION: rethrow ProviderSessionLostError instead of restarting -> the
      // complete fails unexpectedly and the manifest keeps the dropped session.
      const calls: string[] = [];
      const up = uploader({ onComplete: ({ file }) => void calls.push(file.key) });
      const bytes = fileOf(SIZE, 34);
      const input = { fileName: 'lost-session.bin', totalBytes: SIZE, fingerprint: 'fp-ls' };
      const begun = await up.begin(ALICE, input);
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-ls');
      const backend = await backendFor(base());
      const realCommit = backend.commit;
      Object.assign(backend, {
        commit: async (session: Parameters<typeof realCommit>[0]) => {
          await backend.abortSession(session); // what S3 does to the losing upload
          throw new ProviderSessionLostError('A concurrent write to the storage key cancelled this upload.');
        },
      });
      try {
        expect(await code(up.complete(ALICE, id))).toBe('INCOMPLETE');
      } finally {
        Object.assign(backend, { commit: realCommit });
      }
      const manifest = await backend.control.readJson<UploadManifest>(manifestKey(namespaceKeyFor(ALICE.namespace), id));
      expect(manifest?.cloud?.uploadId).toEqual(expect.any(String));
      expect(manifest?.cloud?.uploadId).not.toBe(begun.session.manifest.cloud?.uploadId);
      expect(manifest?.cloud?.key).toBe(begun.session.manifest.cloud?.key);
      expect(manifest?.commitStartedAt).toBeUndefined();
      expect(calls).toEqual([]);

      const again = await up.begin(ALICE, input);
      expect(again.created).toBe(false);
      expect(again.session.missingParts).toEqual(partsOf(SIZE));
      await sendParts(up, ALICE, id, bytes, 'fp-ls');
      const done = await up.complete(ALICE, id);
      expect(calls).toEqual([done.key]);
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
    });

    it.skipIf(kind === 'azure_blob')('an object written after a lifecycle rule aborted the upload is neither claimed nor deleted', async () => {
      // A commit was started (the marker), the server stopped before it ran, a
      // lifecycle rule aborted the multipart upload — its parts are gone, just
      // as after a completion — and another upload wrote the same key. Only the
      // object's own metadata (the session tag) tells the two apart.
      // MUTATION: holdsOwnCommit back to "no parts + an object" -> the complete
      // claims the other upload's object and, its size being wrong, deletes it.
      const up = uploader();
      const bytes = fileOf(SIZE, 35);
      const begun = await up.begin(ALICE, { fileName: 'lifecycle.bin', totalBytes: SIZE, fingerprint: 'fp-lc' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-lc');
      const backend = await backendFor(base());
      const session = begun.session.manifest.cloud as NonNullable<UploadManifest['cloud']>;
      expect(session.objectTag).toMatch(/^[0-9a-f]{16}$/);
      const at = manifestKey(namespaceKeyFor(ALICE.namespace), id);
      const manifest = await backend.control.readJson<UploadManifest>(at);
      await backend.control.write?.(at, JSON.stringify({ ...manifest, commitStartedAt: new Date().toISOString() }));
      await backend.abortSession(session); // the lifecycle rule
      const theirs = "another upload's file";
      await backend.control.write?.(session.key, theirs);
      try {
        expect(await backend.holdsOwnCommit(session)).toBe(false);
        expect(await code(up.complete(ALICE, id))).toBe('DESTINATION_EXISTS');
        await up.discard(ALICE, id);
        expect(Buffer.from(await readAll(backend.openRead(session.key))).toString('utf8')).toBe(theirs);
      } finally {
        await backend.deleteObject(session.key);
      }
    });

    it('two uploads committing onto one shared key at the same moment: exactly one stores, the other is refused', async () => {
      // Both pass the early "is the key taken?" look before either commits; the
      // guarantee is the commit itself, which the storage refuses atomically.
      // MUTATIONS: drop IfNoneMatch from the S3 commit -> both "succeed", one
      // overwriting; drop the ifNoneMatch condition from Azure's commitBlockList
      // -> the winner's commit discards the loser's blocks and the loser fails
      // with a raw InvalidBlockList instead of DESTINATION_EXISTS (either way the
      // outcome assertion fails — verified).
      const up = uploader({ destination: ({ extension }) => `shared/race.${extension}` });
      const alices = fileOf(SIZE, 30);
      const bobs = fileOf(SIZE, 31);
      const a = await up.begin(ALICE, { fileName: 'race.bin', totalBytes: SIZE, fingerprint: 'fp-race-a' });
      const b = await up.begin(BOB, { fileName: 'race.bin', totalBytes: SIZE, fingerprint: 'fp-race-b' });
      await sendParts(up, ALICE, a.session.manifest.uploadId, alices, 'fp-race-a');
      await sendParts(up, BOB, b.session.manifest.uploadId, bobs, 'fp-race-b');

      const backend = await backendFor(base());
      // Each session lists only its OWN parts — deterministic, unlike which
      // file wins. On Azure (proxy) both stage onto the SAME blob. MUTATION:
      // drop the session-tag filter in Azure's listParts -> the earlier stager
      // lists the later one's blocks.
      const ownHashes = (bytes: Uint8Array<ArrayBuffer>) => partsOf(SIZE).map((i) => sha256(partOf(bytes, i, CLOUD_PART_BYTES)));
      expect((await backend.listParts(a.session.manifest.cloud as never)).map((p) => p.sha256)).toEqual(ownHashes(alices));
      expect((await backend.listParts(b.session.manifest.cloud as never)).map((p) => p.sha256)).toEqual(ownHashes(bobs));
      const realCommit = backend.commit;
      const meet = barrier(2);
      Object.assign(backend, {
        commit: async (...args: Parameters<typeof realCommit>) => {
          await meet.arrive(); // both are past the early look
          return realCommit(...args);
        },
      });
      let outcomes: string[];
      try {
        outcomes = await Promise.all([code(up.complete(ALICE, a.session.manifest.uploadId)), code(up.complete(BOB, b.session.manifest.uploadId))]);
      } finally {
        Object.assign(backend, { commit: realCommit });
      }
      expect([...outcomes].sort()).toEqual(['DESTINATION_EXISTS', 'resolved']);
      const [winner, loserCtx, loser] =
        outcomes[0] === 'resolved' ? [alices, BOB, b.session.manifest] : [bobs, ALICE, a.session.manifest];
      expect(sha256(await readAll(backend.openRead('shared/race.bin')))).toBe(sha256(winner));

      // The refused upload keeps no commit marker — so discarding it cannot take
      // the winner's file for its own. Its parts: kept on S3 (each multipart
      // upload is separate); on Azure both staged onto the one shared blob, and
      // Azure discards a blob's uncommitted blocks when it commits — the price
      // of a non-unique destination(), documented.
      const refusedSession = await up.status(loserCtx, loser.uploadId);
      expect(refusedSession.missingParts).toEqual(kind === 'azure_blob' ? partsOf(SIZE) : []);
      expect(refusedSession.manifest.commitStartedAt).toBeUndefined();
      await up.discard(loserCtx, loser.uploadId);
      expect(sha256(await readAll(backend.openRead('shared/race.bin')))).toBe(sha256(winner));
      await backend.deleteObject('shared/race.bin');
    });

    it('never commits over an object it did not create (a destination() that is not unique)', async () => {
      // MUTATION: drop the DESTINATION_EXISTS look and the conditional commit ->
      // the second upload overwrites the first user's file.
      const up = uploader({ destination: ({ extension }) => `shared/one-key.${extension}` });
      const alices = fileOf(SIZE, 25);
      const bobs = fileOf(SIZE, 26);
      const a = await up.begin(ALICE, { fileName: 'mine.bin', totalBytes: SIZE, fingerprint: 'fp-shared-a' });
      await sendParts(up, ALICE, a.session.manifest.uploadId, alices, 'fp-shared-a');
      const stored = await up.complete(ALICE, a.session.manifest.uploadId);

      const b = await up.begin(BOB, { fileName: 'mine.bin', totalBytes: SIZE, fingerprint: 'fp-shared-b' });
      await sendParts(up, BOB, b.session.manifest.uploadId, bobs, 'fp-shared-b');
      expect(await code(up.complete(BOB, b.session.manifest.uploadId))).toBe('DESTINATION_EXISTS');

      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(stored.key)))).toBe(sha256(alices));
      expect((await up.status(BOB, b.session.manifest.uploadId)).missingParts).toEqual([]); // parts kept
      await up.discard(BOB, b.session.manifest.uploadId);
      expect(sha256(await readAll(backend.openRead(stored.key)))).toBe(sha256(alices)); // discard keeps it too
      await backend.deleteObject(stored.key);
    });

    it('a discard drops the commit marker BEFORE it aborts the provider session', async () => {
      // An aborted S3 upload lists no parts, exactly like a completed one. A
      // marker that outlived the abort (a crash right after it) would let another
      // upload's object at a shared key pass for this one's commit.
      // MUTATION: write the manifest without the marker after abortSession (or
      // not at all) -> the manifest still carries the marker when the abort runs.
      const up = uploader();
      const bytes = fileOf(SIZE, 33);
      const begun = await up.begin(ALICE, { fileName: 'marked.bin', totalBytes: SIZE, fingerprint: 'fp-marked' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-marked');
      const backend = await backendFor(base());
      const at = manifestKey(namespaceKeyFor(ALICE.namespace), id);
      // A commit that started and never happened: the marker, parts still there.
      await backend.control.write?.(at, JSON.stringify({ ...begun.session.manifest, commitStartedAt: new Date().toISOString() }));
      const realAbort = backend.abortSession;
      let markerAtAbort: string | undefined | null = null;
      Object.assign(backend, {
        abortSession: async (...args: Parameters<typeof realAbort>) => {
          markerAtAbort = (await backend.control.readJson<UploadManifest>(at))?.commitStartedAt;
          return realAbort(...args);
        },
      });
      try {
        await up.discard(ALICE, id);
      } finally {
        Object.assign(backend, { abortSession: realAbort });
      }
      expect(markerAtAbort).toBeUndefined();
      expect(await code(up.status(ALICE, id))).toBe('NO_SESSION');
    });
  });
});
