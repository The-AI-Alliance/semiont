/**
 * Once per run: bundle the specs the suite checks against — the gateway's API,
 * and the Archivist's HTTP surface its stand-in Archivist is held to — and
 * refuse to start when what the run needs is missing: a missing gateway build
 * or broker must read as that, never as a hundred failing cases.
 *
 * The bundles are made here, from `specs/src`, rather than read from the
 * gitignored bundles in `specs/`: a stale bundle would let the suite pass
 * against a spec that is no longer the source.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { REPO_ROOT } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    /** How a gateway is started: the configuration provides it. */
    gatewayCommand: readonly string[];
    specPath: string;
    archivistSpecPath: string;
  }
}

export default function setup(project: TestProject): () => void {
  const command = project.getProvidedContext().gatewayCommand;
  const entry = command[command.length - 1]!;
  if (!existsSync(entry)) {
    throw new Error(`The gateway is not built: ${entry} does not exist. Run \`cargo build --release -p semiont-gateway\` at the repository root.`);
  }
  try {
    execFileSync('nats-server', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('nats-server is not on PATH. The NATS cases run a real broker; install nats-server 2.10 or later.');
  }

  const dir = mkdtempSync(join(tmpdir(), 'conformance-spec-'));
  const bundle = (source: string, name: string) => {
    const out = join(dir, name);
    execFileSync(join(REPO_ROOT, 'node_modules/.bin/redocly'), ['bundle', source, '-o', out], { cwd: REPO_ROOT, stdio: 'ignore' });
    return out;
  };
  project.provide('specPath', bundle('specs/src/openapi.json', 'openapi.json'));
  project.provide('archivistSpecPath', bundle('specs/src/archivist/openapi.json', 'archivist.openapi.json'));
  return () => rmSync(dir, { recursive: true, force: true });
}
