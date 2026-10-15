'use client';

import { useCallback, useEffect, useState } from 'react';

import { useMultipartUpload } from '@mr_innovations/multipart-upload/react';

import { ensureVisitorId } from './visitor';

interface Unfinished {
  uploadId: string;
  fileName: string;
  totalBytes: number;
  receivedBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function checksumLabel(result: { sha256: string; checksum: { type: string; parts?: number } | null }): string {
  if (result.sha256) return 'SHA-256';
  if (result.checksum?.type === 'sha256-composite') return `Composite SHA-256 (${result.checksum.parts} parts)`;
  return 'Checksum';
}

const STATUS_LABEL = {
  idle: 'Ready',
  uploading: 'Uploading',
  assembling: 'Assembling on the server',
  paused: 'Paused — pick the same file to resume',
  done: 'Upload complete',
  error: 'Upload failed',
} as const;

export function Uploader() {
  const upload = useMultipartUpload({ endpoint: '/api/uploads' });
  const [file, setFile] = useState<File | null>(null);
  const [maxFileBytes, setMaxFileBytes] = useState<number | null>(null);
  // From the server, in `accept` syntax. Empty: every type is allowed.
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);
  const [unfinished, setUnfinished] = useState<Unfinished[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/uploads', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { uploads: Unfinished[]; maxFileBytes: number; allowedTypes?: string[] };
    setUnfinished(body.uploads);
    setMaxFileBytes(body.maxFileBytes);
    setAllowedTypes(body.allowedTypes ?? []);
  }, []);

  useEffect(() => {
    // The visitor id must exist before the first request: the route's
    // `authorize` refuses requests without one.
    ensureVisitorId();
    void refresh();
  }, [refresh]);

  const confirmAndDiscard = useCallback(async () => {
    // Destructive: it deletes every part already on the server.
    const confirmed = window.confirm(
      'Discard this upload? The parts already sent will be deleted from the server.',
    );
    if (!confirmed) return;
    await upload.discard();
    await refresh();
  }, [upload, refresh]);

  useEffect(() => {
    if (upload.status === 'done' || upload.status === 'paused' || upload.status === 'error') void refresh();
  }, [upload.status, refresh]);

  const busy = upload.status === 'uploading' || upload.status === 'assembling';
  const percent = upload.progress?.percent ?? 0;

  return (
    <section className="card" aria-labelledby="upload-heading">
      <h2 id="upload-heading" className="sr-only">
        Upload a file
      </h2>

      <label className="picker">
        <span>Choose a file</span>
        <input
          data-testid="file-input"
          type="file"
          // Only narrows the picker's view; the server checks type and content.
          accept={allowedTypes.length > 0 ? allowedTypes.join(',') : undefined}
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            upload.reset();
          }}
        />
      </label>
      {maxFileBytes !== null && (
        <p className="hint" data-testid="max-size">
          Maximum upload size: {formatBytes(maxFileBytes)} (set by maxFileBytes in the upload route)
        </p>
      )}
      {allowedTypes.length > 0 && (
        <p className="hint" data-testid="allowed-types">
          Allowed types: {allowedTypes.join(', ')} (set by allowedTypes in the upload route)
        </p>
      )}

      <div className="actions">
        <button data-testid="start" disabled={!file || busy} onClick={() => file && void upload.start(file)}>
          {upload.status === 'paused' ? 'Resume' : 'Upload'}
        </button>
        <button data-testid="pause" disabled={upload.status !== 'uploading'} onClick={upload.pause}>
          Pause
        </button>
        <button
          data-testid="discard"
          className="danger"
          disabled={upload.status === 'idle' || upload.status === 'done' || upload.status === 'assembling'}
          onClick={() => void confirmAndDiscard()}
        >
          Discard
        </button>
      </div>

      <div className="status" role="status" aria-live="polite" aria-label="Upload status">
        <div className="status-line">
          <strong data-testid="status">{STATUS_LABEL[upload.status]}</strong>
          {upload.progress && (
            <span data-testid="bytes">
              {formatBytes(upload.progress.sentBytes)} of {formatBytes(upload.progress.totalBytes)} · part{' '}
              {upload.progress.partsDone}/{upload.progress.partsTotal}
              {upload.progress.phase === 'throttled' && ' · throttled by the server'}
            </span>
          )}
        </div>
        <progress data-testid="progress" value={percent} max={100} aria-label="Upload progress">
          {percent}%
        </progress>
        {upload.startInfo?.resumed && (
          <p className="resumed" data-testid="resumed">
            Resumed — {formatBytes(upload.startInfo.receivedBytes)} was already on the server, so only the
            rest is being sent.
          </p>
        )}
      </div>

      {upload.error && (
        <p className="error" role="alert" data-testid="error">
          {upload.error.message}
        </p>
      )}

      {upload.result && (
        <dl className="result" data-testid="result">
          <dt>File</dt>
          <dd>{upload.result.fileName}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(upload.result.size)}</dd>
          <dt>Type</dt>
          <dd className="mono" data-testid="content-type">
            {upload.result.contentType}
          </dd>
          {/* Local storage: the exact SHA-256 of the stored file. Cloud storage
              (S3, MinIO, Azure) cannot compute one for a multipart file, so it
              shows the composite SHA-256 — or that none was verified. */}
          <dt>{checksumLabel(upload.result)}</dt>
          <dd className="mono" data-testid="sha256">
            {upload.result.sha256 || upload.result.checksum?.value || 'not verified by this storage'}
          </dd>
          <dt>Stored as</dt>
          <dd className="mono">{upload.result.key}</dd>
          {upload.result.deduplicated && (
            <>
              <dt>Note</dt>
              <dd>Identical content was already stored, so it was reused.</dd>
            </>
          )}
        </dl>
      )}

      {unfinished.length > 0 && (
        <div className="unfinished">
          <h3>Unfinished uploads on the server</h3>
          <ul data-testid="unfinished">
            {unfinished.map((u) => (
              <li key={u.uploadId}>
                <span>{u.fileName}</span>
                <span className="mono">
                  {formatBytes(u.receivedBytes)} / {formatBytes(u.totalBytes)}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">Pick the same file above to resume one of these.</p>
        </div>
      )}
    </section>
  );
}
