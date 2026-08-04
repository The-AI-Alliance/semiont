import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileTypst, PINNED_CREATION_TIMESTAMP } from '../typst-compiler';

/**
 * Compiler-invocation mechanics, tested against a FAKE `typst` executable
 * prepended to PATH — the real binary lives only in the worker image (P2) and
 * the fixture-generation setup (P4). What this file pins is OUR side of the
 * contract: argument order, the mandatory --creation-timestamp (determinism —
 * unpinned compiles change bytes on identical input, churning checksums into
 * permanent re-embeds), temp-file plumbing, byte return, and legible error
 * capture. Real-compile coverage arrives with P4's fixture globalSetup.
 */
describe('compileTypst (PDF-GENERATION P3)', () => {
  let fakeDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    fakeDir = mkdtempSync(join(tmpdir(), 'fake-typst-'));
    savedPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${savedPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(fakeDir, { recursive: true, force: true });
  });

  /** Install a fake `typst` that records its argv and behaves per `body`. */
  function installFakeTypst(body: string): string {
    const argsFile = join(fakeDir, 'argv');
    const script = `#!/bin/sh\necho "$@" > "${argsFile}"\n${body}\n`;
    const bin = join(fakeDir, 'typst');
    writeFileSync(bin, script);
    chmodSync(bin, 0o755);
    return argsFile;
  }

  it('compiles source to PDF bytes, pinning the creation timestamp', () => {
    // The fake writes a recognizable byte payload to the output path (last arg).
    const argsFile = installFakeTypst(
      'for last in "$@"; do :; done; printf "%%PDF-FAKE" > "$last"',
    );

    const result = compileTypst('= Title\nBody text.');

    expect('pdf' in result && result.pdf).toBeInstanceOf(Uint8Array);
    if (!('pdf' in result)) throw new Error('expected pdf');
    expect(new TextDecoder().decode(result.pdf)).toBe('%PDF-FAKE');

    const argv = readFileSync(argsFile, 'utf8');
    expect(argv).toContain('compile');
    expect(argv).toContain(`--creation-timestamp ${PINNED_CREATION_TIMESTAMP}`);
  });

  it('captures the legible compile error on failure', () => {
    installFakeTypst(
      'echo "error: unclosed delimiter\\n  ┌─ doc.typ:3:9" >&2; exit 2',
    );

    const result = compileTypst('#let broken = [unclosed');

    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('expected error');
    expect(result.error).toContain('unclosed delimiter');
  });
});
