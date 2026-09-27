/**
 * Once per run: bundle the spec the suite checks against, and refuse to start
 * when what the run needs is missing — a missing gateway build or broker must
 * read as that, never as a hundred failing cases.
 *
 * The bundle is made here, from `specs/src`, rather than read from the
 * gitignored `specs/openapi.json`: a stale bundle would let the suite pass
 * against a spec that is no longer the source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { GATEWAY_COMMAND, REPO_ROOT } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    specPath: string;
  }
}

export default function setup(project: TestProject): () => void {
  const entry = GATEWAY_COMMAND[GATEWAY_COMMAND.length - 1]!;
  if (!existsSync(entry)) {
    throw new Error(`The gateway is not built: ${entry} does not exist. Run \`npm run build -w semiont-gateway\` at the repository root.`);
  }
  try {
    execFileSync('nats-server', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('nats-server is not on PATH. The NATS cases run a real broker; install nats-server 2.10 or later.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'gateway-conformance-spec-'));
  const specPath = join(dir, 'openapi.json');
  execFileSync(
    join(REPO_ROOT, 'node_modules/.bin/redocly'),
    ['bundle', 'specs/src/openapi.json', '-o', specPath],
    { cwd: REPO_ROOT, stdio: 'ignore' },
  );
  project.provide('specPath', specPath);
  return () => rmSync(dir, { recursive: true, force: true });
}
