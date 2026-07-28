/**
 * Print the DATABASE_URL derived from this KB's config, and nothing else.
 *
 * (No shebang here — tsup's `banner` adds one to every entry; a second copy in
 * the source makes the bundle unparseable.)
 *
 * The container's CMD captures stdout and exports it before running
 * `prisma migrate deploy` and then the server:
 *
 *   if [ -z "$DATABASE_URL" ]; then
 *     DATABASE_URL="$(node "$BACKEND_DIR/dist/cli/db-url.js")"; export DATABASE_URL
 *   fi
 *
 * Why a separate process rather than deriving it inside the server:
 *
 *  1. `migrate deploy` is its own process, started BEFORE the server. It reads
 *     the datasource url from prisma.config.ts (`process.env.DATABASE_URL`), so
 *     anything the server assembles internally is invisible to it — which is
 *     why the documented DB_HOST/DB_USER/... component form never worked for
 *     migrations.
 *  2. Even within the server it would be too late. The bundler emits module
 *     bodies in dependency order, so src/db.ts's module-scope client
 *     construction runs before index.ts's own top-level statements. Setting
 *     DATABASE_URL before node starts sidesteps the ordering question entirely.
 *
 * And why the value is derived HERE rather than injected by the launcher: set
 * inside the container, the password never appears in `container inspect`. That
 * is the same rule the launcher already keeps for the admin password (see
 * backendArgs in apps/launcher/internal/launcher/start.go).
 *
 * Stdout is the contract: the URL, no trailing newline, nothing else. Diagnostics
 * go to stderr, and a failure exits non-zero so the CMD's `set -e` aborts before
 * migrating.
 */

import { loadEnvironmentConfig } from '@semiont/core/node';
import { databaseUrlFrom } from '../utils/database-url';

const projectRoot = process.env.SEMIONT_ROOT;
if (!projectRoot) {
  process.stderr.write('SEMIONT_ROOT is not set — cannot locate the knowledge base config\n');
  process.exit(1);
}

try {
  process.stdout.write(databaseUrlFrom(loadEnvironmentConfig(projectRoot)));
} catch (error) {
  process.stderr.write(
    `Could not derive DATABASE_URL from config: ${error instanceof Error ? error.message : String(error)}\n` +
    'Set DATABASE_URL explicitly to bypass this derivation.\n',
  );
  process.exit(1);
}
