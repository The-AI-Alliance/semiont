/**
 * Nothing blinds the compiler about the bus.
 *
 * The compiler is the worklist for a change to the bus's surface: delete a
 * verb and every call site becomes a type error, which is exhaustive by
 * construction in a way grep and reading are not. That only holds while the
 * compiler can SEE every call site.
 *
 * An `any`-typed receiver is the hole: `(eventBus as any).get('x')` compiles
 * whatever `get`'s signature is — or whether it exists at all. A site behind
 * one is invisible to the worklist, survives a migration untouched, and
 * fails at runtime instead.
 *
 * Cast test doubles are the same mechanism, one interface over: a required
 * member added to `ITransport` compiles clean across every cast double and
 * fails only at runtime.
 *
 * A THIRD mechanism this census cannot see, recorded so the next reader knows
 * the gate is not total: `require()` inside `vi.hoisted()` returns `any`, so a
 * real object obtained that way carries no type at all. A regex cannot
 * distinguish it from any other untyped value — running the suites is what
 * catches it, which is why a bus change is verified by running the suites
 * and not by typechecks alone.
 *
 * NOT banned: re-typing the RESULT of a typed call as another read-only type
 * (`bus.on(ch) as unknown as Observable<T>`). The call itself is still
 * checked, so the worklist still sees it. The ban is on making the BUS
 * untyped, and on re-typing a read view WRITABLE (the second shape below).
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', 'build']);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Two shapes, both measured to blind the compiler about the bus:
 *   (bus as any).get(...)                       — an any receiver
 *   (bus.on(ch) as unknown as Subject<T>).next  — a read view re-typed WRITABLE
 *
 * With the second, `tsc` is clean and `client.bus.on(...).next is not a
 * function` appears only under vitest.
 */
const BLINDED =
  /\(\s*[\w.]+\s+as\s+any\s*\)\s*\.\s*(get|scope|emit|on|frames)\s*\(|\.\s*(on|frames)\([^()]*\)\s*as\s+(?:unknown\s+as\s+)?(Subject|any|\{\s*next)/g;

describe('the compiler can see every bus call site', () => {
  test('no bus verb is reached through an any-typed receiver', () => {
    const offenders: string[] = [];
    for (const file of sources(join(REPO, 'packages'))) {
      for (const m of stripComments(readFileSync(file, 'utf-8')).matchAll(BLINDED)) {
        offenders.push(`${relative(REPO, file)} — ${m[0].trim()}`);
      }
    }
    for (const file of sources(join(REPO, 'apps'))) {
      for (const m of stripComments(readFileSync(file, 'utf-8')).matchAll(BLINDED)) {
        offenders.push(`${relative(REPO, file)} — ${m[0].trim()}`);
      }
    }
    expect(
      offenders,
      'bus call sites the compiler cannot check: a verb on an any-typed receiver, or a read view re-typed writable',
    ).toEqual([]);
  });
});
