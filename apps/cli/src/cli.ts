/**
 * Semiont CLI — deprecated.
 *
 * Every verb this package once provided now lives elsewhere:
 *
 *   - Stack and knowledge-work verbs → the `semiont` launcher, a single static
 *     binary installed with Homebrew.
 *   - Programmatic access → `@semiont/sdk`.
 *   - Backup / restore / export / import → backend endpoints under
 *     `/api/{admin,moderate}/exchange/*`, surfaced in the browser UI.
 *
 * This entry point remains only so an existing install says so out loud instead
 * of failing obscurely. It performs no work.
 */

import { pathToFileURL } from 'url';

// Injected by esbuild at build time via __SEMIONT_VERSION__ define
declare const __SEMIONT_VERSION__: string;
const VERSION: string = __SEMIONT_VERSION__;

const NOTICE = `Deprecated.

@semiont/cli no longer provides any commands.

Install the Semiont launcher instead:

    brew install the-ai-alliance/semiont/semiont

Then run it from your knowledge-base directory:

    semiont start

For programmatic access, use @semiont/sdk (https://www.npmjs.com/package/@semiont/sdk).
`;

export function main(argv: string[]): number {
  const arg = argv[0];

  if (arg === '--version' || arg === '-v') {
    console.log(`@semiont/cli v${VERSION} (deprecated)`);
    return 0;
  }

  if (arg === '--help' || arg === '-h' || argv.length === 0) {
    console.log(NOTICE);
    return 0;
  }

  // Anything else was a real request. Say so on stderr and fail, so scripts and
  // container entrypoints surface it immediately rather than continuing as if
  // the work had happened.
  console.error(NOTICE);
  return 1;
}

// Only act when run as the binary — importing this module (tests) must not exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
