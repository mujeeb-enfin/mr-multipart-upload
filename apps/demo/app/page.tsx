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
        This demo has no accounts, so each browser is identified by a visitor cookie and sees only
        its own uploads. A real application returns its signed-in user&apos;s id from the{' '}
        <code>authorize</code> function passed to <code>createUploadRoutes</code>.
      </p>
    </main>
  );
}
