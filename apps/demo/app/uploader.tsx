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
  const [unfinished, setUnfinished] = useState<Unfinished[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/uploads', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { uploads: Unfinished[]; maxFileBytes: number };
    setUnfinished(body.uploads);
    setMaxFileBytes(body.maxFileBytes);
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
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            upload.reset();
          }}
        />
      </label>
      {maxFileBytes !== null && (
        <p className="hint" data-testid="max-size">
          Maximum upload size: {formatBytes(maxFileBytes)} (set by MULTIPART_UPLOAD_MAX_FILE_BYTES)
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
          <dt>SHA-256</dt>
          <dd className="mono" data-testid="sha256">
            {upload.result.sha256}
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
