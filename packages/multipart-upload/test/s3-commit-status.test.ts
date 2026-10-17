// ---------------------------------------------------------------------------
// s3-commit-status.test.ts — what each answer to the conditional commit means
// ---------------------------------------------------------------------------
//
// The S3 commit sends `If-None-Match: *`, and each refusal means something
// different: 501 / NotImplemented (the store has no conditional writes — retry
// without the condition), 412 (the key is taken — DESTINATION_EXISTS), 409
// (a concurrent write dropped this multipart upload — restart the session).
// These answers cannot be provoked on demand from an emulator, so the SDK is
// replaced by one that records every command and answers as each case needs.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadError } from '../src/core/errors.js';
import { createS3Backend } from '../src/storage/cloud/s3-backend.js';
import { ProviderSessionLostError, type CloudBackend } from '../src/storage/cloud/types.js';

interface SentCommand {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const sent: SentCommand[] = [];
/** How each CompleteMultipartUpload is answered, in order; `undefined` succeeds. */
let completeAnswers: (unknown | undefined)[] = [];
/** The object at the key, as HeadObject reports it; null: none. */
let storedObject: { Metadata: Record<string, string> } | null = null;
/** Parts ListParts reports for the session. */
let listedParts: { PartNumber: number; Size: number }[] = [];

function command(name: string) {
  return class {
    readonly name = name;
    constructor(readonly input: Record<string, unknown>) {}
  };
}

const fakeSdk = {
  S3Client: class {
    async send(cmd: SentCommand) {
      sent.push({ name: cmd.name, input: cmd.input });
      if (cmd.name === 'CompleteMultipartUpload') {
        const answer = completeAnswers.shift();
        if (answer !== undefined) throw answer;
        return {};
      }
      if (cmd.name === 'CreateMultipartUpload') return { UploadId: 'mpu-new' };
      if (cmd.name === 'ListParts') return { Parts: listedParts };
      if (cmd.name === 'HeadObject') {
        if (!storedObject) throw awsError(404, 'NotFound');
        return { ContentLength: 8, Metadata: storedObject.Metadata };
      }
      return {};
    }
  },
  CompleteMultipartUploadCommand: command('CompleteMultipartUpload'),
  CreateMultipartUploadCommand: command('CreateMultipartUpload'),
  HeadObjectCommand: command('HeadObject'),
  ListObjectsV2Command: command('ListObjectsV2'),
  ListPartsCommand: command('ListParts'),
};

vi.mock('../src/storage/cloud/load-optional.js', () => ({ loadOptional: async () => fakeSdk }));

/** An error shaped like the AWS SDK's: the HTTP status sits in `$metadata`. */
function awsError(status: number | undefined, name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

const SESSION = { kind: 'aws_s3' as const, key: 'files/u/a.bin', uploadId: 'mpu-1' };
const PARTS = [
  { index: 2, size: 3, sha256: 'b'.repeat(64), etag: '"e2"' },
  { index: 1, size: 5, sha256: 'a'.repeat(64), etag: '"e1"' },
];

let backend: CloudBackend;

beforeEach(async () => {
  sent.length = 0;
  completeAnswers = [];
  storedObject = null;
  listedParts = [];
  backend = await createS3Backend({ kind: 'aws_s3', bucket: 'b', region: 'us-east-1', prefix: '', forcePathStyle: true });
});

const completes = () => sent.filter((c) => c.name === 'CompleteMultipartUpload');

describe('S3 conditional commit', () => {
  it('commits only if the key is free, with the parts in order', async () => {
    const result = await backend.commit(SESSION, PARTS, 'application/octet-stream');
    expect(result.key).toBe(SESSION.key);
    expect(result.size).toBe(8);
    expect(completes()).toHaveLength(1);
    expect(completes()[0]?.input.IfNoneMatch).toBe('*');
    const parts = (completes()[0]?.input.MultipartUpload as { Parts: { PartNumber: number }[] }).Parts;
    expect(parts.map((p) => p.PartNumber)).toEqual([1, 2]);
  });

  it.each([
    ['a 501 status', awsError(501, 'NotImplemented')],
    ['a NotImplemented error without a status', awsError(undefined, 'NotImplemented')],
  ])('retries WITHOUT the condition after %s, and stores', async (_label, refusal) => {
    // MUTATION: drop the 501 fallback -> the commit rejects and the upload fails
    // on every store without conditional writes.
    completeAnswers = [refusal];
    const result = await backend.commit(SESSION, PARTS, 'application/octet-stream');
    expect(result.size).toBe(8);
    expect(completes().map((c) => c.input.IfNoneMatch)).toEqual(['*', undefined]);
  });

  it('reports a taken key (412) as DESTINATION_EXISTS, without retrying', async () => {
    completeAnswers = [awsError(412, 'PreconditionFailed')];
    const refused = await backend.commit(SESSION, PARTS, 'application/octet-stream').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UploadError);
    expect((refused as UploadError).code).toBe('DESTINATION_EXISTS');
    expect(completes()).toHaveLength(1);
  });

  it('reports a session dropped by a concurrent write (409) as ProviderSessionLostError', async () => {
    // MUTATION: map 409 to DESTINATION_EXISTS -> the caller would refuse an
    // upload whose key is free, with its parts already gone.
    completeAnswers = [awsError(409, 'ConditionalRequestConflict')];
    const refused = await backend.commit(SESSION, PARTS, 'application/octet-stream').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ProviderSessionLostError);
    expect(completes()).toHaveLength(1);
  });

  it('passes any other failure through unchanged', async () => {
    const outage = awsError(500, 'InternalError');
    completeAnswers = [outage];
    expect(await backend.commit(SESSION, PARTS, 'application/octet-stream').catch((err: unknown) => err)).toBe(outage);
    expect(completes()).toHaveLength(1);
  });
});

describe('S3 session tag — proof that an object is this session\'s own commit', () => {
  it('stamps a fresh tag on every multipart upload and keeps it in the session', async () => {
    const first = await backend.createSession('files/u/a.bin', 'image/png');
    const second = await backend.createSession('files/u/a.bin', 'image/png');
    expect(first.objectTag).toMatch(/^[0-9a-f]{16}$/);
    expect(second.objectTag).not.toBe(first.objectTag);
    const created = sent.filter((c) => c.name === 'CreateMultipartUpload');
    expect(created.map((c) => c.input.Metadata)).toEqual([{ mpusession: first.objectTag }, { mpusession: second.objectTag }]);
  });

  const TAGGED = { ...SESSION, objectTag: '0123456789abcdef' };

  it('claims an object carrying its own tag', async () => {
    storedObject = { Metadata: { mpusession: TAGGED.objectTag } };
    expect(await backend.holdsOwnCommit(TAGGED)).toBe(true);
  });

  it.each([
    ['another session\'s tag', { mpusession: 'fedcba9876543210' }],
    ['no tag (written by anything else)', {}],
  ])('never claims an object carrying %s', async (_label, metadata) => {
    // MUTATION: drop the metadata comparison -> another upload's object, written
    // after a lifecycle rule aborted this one, passes for this session's commit.
    storedObject = { Metadata: metadata };
    expect(await backend.holdsOwnCommit(TAGGED)).toBe(false);
  });

  it('claims nothing while the upload still lists parts, or when no object exists', async () => {
    storedObject = { Metadata: { mpusession: TAGGED.objectTag } };
    listedParts = [{ PartNumber: 1, Size: 5 }];
    expect(await backend.holdsOwnCommit(TAGGED)).toBe(false);
    listedParts = [];
    storedObject = null;
    expect(await backend.holdsOwnCommit(TAGGED)).toBe(false);
  });

  it('keeps recognising the commit of a session started before tags existed', async () => {
    // A 0.3.0 upload resumed on this version has no tag: "no parts left and an
    // object at the key" is still the evidence, so its interrupted commit finishes.
    storedObject = { Metadata: {} };
    expect(await backend.holdsOwnCommit(SESSION)).toBe(true);
  });
});
