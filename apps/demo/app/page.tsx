import { Uploader } from './uploader';

export default function Page() {
  return (
    <main className="page">
      <header className="intro">
        <h1>multipart-upload</h1>
        <p>
          Pick a file and upload it in parts. Pause, reload the page, or lose your connection —
          picking the same file again sends only the parts the server does not have yet.
        </p>
      </header>
      <Uploader />
      <p className="footnote">
        This demo accepts anonymous uploads. A real application passes an <code>authorize</code>{' '}
        function to <code>createUploadRoutes</code> so each user&apos;s uploads are isolated.
      </p>
    </main>
  );
}
