import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Registry-level invariants for specs/src/bus/registry.json.
//
// The bus's classification rules used to live only in TypeScript, where
// `satisfies` clauses caught violations at `tsc` time. They still do — but
// only AFTER generation, pointing at a generated file rather than at the line
// you actually typed, and only for the properties TypeScript can express.
// These assertions run at the source, in the language-neutral layer, so the
// error names the registry entry and applies to every generated language.
//
// Both generators import and run this, so no generated artifact can be
// produced from a registry that violates them.

/**
 * The registry's ON-DISK form, not just its content.
 *
 * JSON has more than one faithful spelling of the same document, and the
 * editors that touch this file disagree about which to write: `JSON.stringify`
 * emits `—` literally, Python's `json.dumps` escapes it to `—`, and both
 * round-trip losslessly. So a one-line semantic change lands as a whole-file
 * re-encoding. It happened on PR #1127: a diff of +132/-65 whose real content
 * was +68/-1 — roughly half the lines were the same characters respelled.
 *
 * That is not cosmetic here. This file is the bus AUTHORITY, the file two
 * concurrent branches are most likely to touch at once, and a re-encoding
 * conflicts on nearly every line while hiding the change under review.
 *
 * The canonical form is what `JSON.stringify(reg, null, 2)` produces, plus a
 * trailing newline: the repo's own generators are JS, and the committed file
 * already matches it byte-for-byte, so adopting it costs no diff.
 */
export function validateRegistryFormat(raw) {
  const canonical = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  if (raw === canonical) return;
  throw new Error(
    `specs/src/bus/registry.json is not in canonical form.\n\n` +
      `  Its CONTENT may be fine — this is about how the bytes are spelled ` +
      `(escaping, indentation, trailing newline).\n` +
      `  Left alone it lands as a whole-file diff that conflicts with every ` +
      `other branch touching the registry.\n\n` +
      `  Fix it in place:  node scripts/bus/validate-registry.mjs --fix\n`,
  );
}

/** A violation names the rule and the offending entry — never just "invalid". */
function fail(problems) {
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p}`).join('\n');
  throw new Error(
    `specs/src/bus/registry.json violates ${problems.length} bus invariant(s):\n${lines}\n\n` +
      `These are the cross-list rules the event bus depends on; see docs/protocol/EVENT-BUS.md.`,
  );
}

export function validateRegistry(reg) {
  const problems = [];
  const declared = new Set();

  // ── channels are uniquely declared ──────────────────────────────────────
  // A duplicate entry makes every derived map ambiguous, and the last one
  // silently wins.
  for (const c of reg.channels) {
    if (declared.has(c.channel)) problems.push(`channel "${c.channel}" is declared more than once`);
    declared.add(c.channel);
  }

  const known = (ch, where) => {
    if (!declared.has(ch)) problems.push(`${where} names "${ch}", which is not declared in channels[]`);
  };

  // ── every operation channel exists, and requests are emittable ──────────
  // A reply channel that isn't declared can never be bridged, so the caller
  // waits out the full 30 s timeout with no error — the silent failure the
  // operations registry exists to prevent.
  const replies = new Map(); // reply channel → the operation that owns it
  for (const op of reg.operations) {
    known(op.request, `operations[${op.request}].request`);
    known(op.result, `operations[${op.request}].result`);
    known(op.failure, `operations[${op.request}].failure`);
    if (op.progress) known(op.progress, `operations[${op.request}].progress`);

    // The request channel must carry a payload schema: `/bus/emit` validates
    // against it, and an unvalidatable request channel cannot be emitted.
    const req = reg.channels.find((c) => c.channel === op.request);
    if (req && !req.validate) {
      problems.push(
        `operations[${op.request}].request is not emittable (no schema in channels[]) — ` +
          `busRequest could never send it`,
      );
    }

    // Two operations sharing a reply channel make correlation ambiguous and
    // duplicate the channel in every derived bridged set.
    for (const [kind, ch] of [['result', op.result], ['failure', op.failure], ['progress', op.progress]]) {
      if (!ch) continue;
      const owner = replies.get(ch);
      if (owner) {
        problems.push(`"${ch}" is the ${kind} of BOTH ${owner} and ${op.request} — reply channels are owned by one operation`);
      } else {
        replies.set(ch, op.request);
      }
    }
  }

  // ── bridgedBroadcasts holds only channels no operation owns ─────────────
  // This is the rule the BRIDGED_BROADCASTS doc comment states in prose: a
  // reply channel belongs in operations, where the bridged set DERIVES it.
  // Listing one here duplicates it in BRIDGED_CHANNELS, and the backend SSE
  // forwarder maps `?channel=` entries 1:1 with no dedup — so every event on
  // it is delivered twice (.plans/bugs/BRIDGE-GAPS.md).
  const seenBroadcast = new Set();
  for (const ch of reg.bridgedBroadcasts.channels) {
    known(ch, 'bridgedBroadcasts.channels');
    if (seenBroadcast.has(ch)) problems.push(`bridgedBroadcasts lists "${ch}" more than once`);
    seenBroadcast.add(ch);
    const owner = replies.get(ch);
    if (owner) {
      problems.push(
        `bridgedBroadcasts lists "${ch}", but it is a reply of operation "${owner}" — ` +
          `it is already bridged by derivation; listing it here double-delivers it`,
      );
    }
  }

  fail(problems);
}

// Run directly to check the on-disk form, or `--fix` to rewrite it. The
// generators only ever CHECK: this file is hand-authored authority, and a
// generator that silently reformatted its own input would be the surprise
// this gate exists to prevent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = resolve(dirname(fileURLToPath(import.meta.url)), '../../specs/src/bus/registry.json');
  const raw = readFileSync(registry, 'utf8');
  if (process.argv.includes('--fix')) {
    const canonical = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    if (raw === canonical) {
      console.log('specs/src/bus/registry.json is already canonical.');
    } else {
      writeFileSync(registry, canonical);
      console.log('specs/src/bus/registry.json rewritten in canonical form.');
    }
  } else {
    validateRegistryFormat(raw);
    validateRegistry(JSON.parse(raw));
    console.log('specs/src/bus/registry.json is canonical and satisfies every bus invariant.');
  }
}
