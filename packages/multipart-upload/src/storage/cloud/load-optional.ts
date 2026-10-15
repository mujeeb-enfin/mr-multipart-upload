// ---------------------------------------------------------------------------
// cloud/load-optional.ts — import an optional SDK only when it is used
// ---------------------------------------------------------------------------
//
// The cloud SDKs are OPTIONAL peer dependencies: an application on local storage
// installs none of them. They are imported at runtime, by a computed specifier,
// so a bundler (Next.js) never tries to resolve a package the application did
// not install. The `webpackIgnore` / `@vite-ignore` hints say the same thing to
// bundlers that look at dynamic imports.
// ---------------------------------------------------------------------------

import { UploadError } from '../../core/errors.js';

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** Import `specifier`, or fail with an error telling the developer what to install. */
export async function loadOptional<T>(specifier: string, neededFor: string): Promise<T> {
  try {
    return (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as T;
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new UploadError(
        'CONFIG_INVALID',
        `${neededFor} needs the optional package ${specifier}. Install it: npm install ${specifier}`,
      );
    }
    throw err;
  }
}
