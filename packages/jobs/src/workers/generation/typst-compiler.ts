/**
 * Typst compiler invocation (PDF-GENERATION P3).
 *
 * The model writes Typst source (Q1, settled 2026-08-04: direct Typst); this
 * module turns it into PDF bytes via the pinned binary the worker image ships
 * (P2 — `/usr/local/bin/typst`, v0.15.1, resolved through PATH so tests can
 * substitute a fake). Compile failures return the legible error text — Typst's
 * `file:line:col` + caret diagnostics are the load-bearing input to the bounded
 * repair loop in `processGenerationJob`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every compile pins the PDF creation timestamp. Unpinned compiles of
 * identical source produce different bytes every time (CreationDate/ModDate),
 * which churns the content checksum and makes the Smelter re-embed a document
 * that did not change — the spurious-re-embed failure S11/S12 exist to
 * prevent. The value is arbitrary; its fixity is the point.
 */
export const PINNED_CREATION_TIMESTAMP = 1700000000;

/**
 * Model-authored source can fail to compile; the error is fed back for repair
 * a bounded number of times, then the job fails loudly with the compiler's
 * diagnostics. Bounded because generation is non-idempotent and paid per
 * attempt — this is a repair loop, not a retry loop.
 */
export const MAX_COMPILE_REPAIRS = 2;

export function compileTypst(source: string): { pdf: Uint8Array } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'typst-'));
  try {
    const inFile = join(dir, 'doc.typ');
    const outFile = join(dir, 'doc.pdf');
    writeFileSync(inFile, source);
    try {
      execFileSync(
        'typst',
        ['compile', '--creation-timestamp', String(PINNED_CREATION_TIMESTAMP), inFile, outFile],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr;
      return { error: stderr?.length ? stderr.toString('utf8') : String(err) };
    }
    return { pdf: new Uint8Array(readFileSync(outFile)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
