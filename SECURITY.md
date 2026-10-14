# Security policy

## Reporting a vulnerability

Please report security issues privately, using GitHub's **"Report a vulnerability"** button on this repository's Security tab, rather than in a public issue.

Include the version, a description of the issue and, where possible, a minimal reproduction. You will receive an acknowledgement, and a fix will be released as a patch version once confirmed.

## Supported versions

Only the latest published version receives security fixes.

## Scope notes

These are by design, not vulnerabilities:

- The upload fingerprint is not a secret. It distinguishes one file from another; access control is the application's `authorize` function.
- `allowAnonymous: true` lets anyone upload, up to `MULTIPART_UPLOAD_MAX_FILE_BYTES`. It exists for demos and must not be used for public endpoints without other protection.
- Rate limiting is not built in. Large uploads make many requests; apply limits at your proxy or middleware, and note the client already backs off and slows down on `429`.
