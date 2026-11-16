import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

/**
 * Apply the backend's Prisma schema to a test database via `prisma db push`.
 *
 * Resolves the prisma CLI through Node module resolution rather than a hardcoded
 * `node_modules/.bin/prisma` path — prisma may hoist to the workspace root
 * instead of apps/backend/node_modules — then runs the resolved entry with node.
 */
export function applyTestSchema(connectionString: string): void {
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const schemaPath = path.join(backendRoot, 'prisma/schema.prisma');
  const prismaPkgPath = require.resolve('prisma/package.json');
  const prismaPkg = require('prisma/package.json') as { bin: string | { prisma: string } };
  const binRel = typeof prismaPkg.bin === 'string' ? prismaPkg.bin : prismaPkg.bin.prisma;
  const prismaCli = path.join(path.dirname(prismaPkgPath), binRel);
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', `--schema=${schemaPath}`, `--url=${connectionString}`, '--accept-data-loss'],
    { stdio: 'pipe', cwd: backendRoot },
  );
}
