// ---------------------------------------------------------------------------
// use-multipart-upload.ts — the React hook for client components
// ---------------------------------------------------------------------------
//
//   const upload = useMultipartUpload({ endpoint: '/api/uploads' });
//   <input type="file" onChange={(e) => upload.start(e.target.files![0])} />
//   <progress value={upload.progress?.percent ?? 0} max={100} />
//   <button onClick={upload.pause}>Pause</button>
//   <button onClick={upload.resume}>Resume</button>
//
// RESUME NEEDS NO STATE OF ITS OWN. `resume()` simply starts the same file
// again; the server recognises it from the name and fingerprint and answers with
// only the missing parts. After a page reload, picking the same file does the
// same thing — which is why nothing here is persisted.
//
// UNMOUNTING PAUSES, it does not discard. Navigating away must not throw away
// parts the user has already paid for.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';

import { UploadClientError } from '../client/errors.js';
import {
  type StartUploadOptions,
  type UploadHandle,
  type UploadProgress,
  type UploadResult,
  type UploadStartInfo,
  startUpload,
} from '../client/upload.js';

export type UploadStatus = 'idle' | 'uploading' | 'assembling' | 'paused' | 'done' | 'error';

export type UseMultipartUploadOptions = Omit<StartUploadOptions, 'file' | 'onProgress' | 'onStart'>;

export interface UseMultipartUpload {
  readonly status: UploadStatus;
  readonly progress: UploadProgress | null;
  /** Server's answer at begin — `resumed` is true when parts were already there. */
  readonly startInfo: UploadStartInfo | null;
  readonly result: UploadResult | null;
  readonly error: UploadClientError | null;
  /** Upload a file, or resume it if the server already holds some of its parts. */
  start(file: File, overrides?: { metadata?: Record<string, unknown> }): Promise<UploadResult | null>;
  /** Stop sending; server parts are kept. */
  pause(): void;
  /** Start the last file again — only its missing parts are sent. */
  resume(): Promise<UploadResult | null>;
  /** Stop and delete the server's parts. */
  discard(): Promise<void>;
  /** Back to idle, forgetting the last result and error. Does not touch the server. */
  reset(): void;
}

export function useMultipartUpload(options: UseMultipartUploadOptions = {}): UseMultipartUpload {
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [startInfo, setStartInfo] = useState<UploadStartInfo | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<UploadClientError | null>(null);

  // Latest options without restarting anything when the caller re-renders with
  // a new object literal. Synced in an effect, not during render: renders must
  // stay pure. `start` is only ever called from events after commit, so it
  // always sees the committed options.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const handleRef = useRef<UploadHandle | null>(null);
  const lastFileRef = useRef<{ file: File; metadata?: Record<string, unknown> } | null>(null);
  const mountedRef = useRef(true);
  const runRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      handleRef.current?.pause();
    };
  }, []);

  const start = useCallback(async (file: File, overrides?: { metadata?: Record<string, unknown> }) => {
    handleRef.current?.pause();
    const run = ++runRef.current;
    // Only the newest run may update state; a superseded one finishing late
    // must not overwrite it.
    const live = () => mountedRef.current && run === runRef.current;

    const metadata = overrides?.metadata ?? optionsRef.current.metadata;
    lastFileRef.current = { file, metadata };
    setStatus('uploading');
    setError(null);
    setResult(null);
    setProgress(null);
    setStartInfo(null);

    const handle = startUpload({
      ...optionsRef.current,
      file,
      metadata,
      onStart: (info) => live() && setStartInfo(info),
      onProgress: (p) => {
        if (!live()) return;
        setProgress(p);
        if (p.phase === 'assembling') setStatus('assembling');
      },
    });
    handleRef.current = handle;

    try {
      const finished = await handle.promise;
      if (live()) {
        setResult(finished);
        setStatus('done');
      }
      return finished;
    } catch (err) {
      const clientError =
        err instanceof UploadClientError ? err : new UploadClientError(String(err), 0, 'UNKNOWN');
      if (live()) {
        if (clientError.code === 'PAUSED') {
          setStatus('paused');
        } else {
          setError(clientError);
          setStatus('error');
        }
      }
      return null;
    }
  }, []);

  const pause = useCallback(() => handleRef.current?.pause(), []);

  const resume = useCallback(async () => {
    const last = lastFileRef.current;
    return last ? start(last.file, { metadata: last.metadata }) : null;
  }, [start]);

  const discard = useCallback(async () => {
    runRef.current += 1;
    await handleRef.current?.discard();
    handleRef.current = null;
    lastFileRef.current = null;
    if (mountedRef.current) {
      setStatus('idle');
      setProgress(null);
      setStartInfo(null);
    }
  }, []);

  const reset = useCallback(() => {
    runRef.current += 1;
    handleRef.current = null;
    setStatus('idle');
    setProgress(null);
    setStartInfo(null);
    setResult(null);
    setError(null);
  }, []);

  return { status, progress, startInfo, result, error, start, pause, resume, discard, reset };
}
