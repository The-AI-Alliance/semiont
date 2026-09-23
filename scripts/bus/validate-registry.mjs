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
 * emits an em-dash as the literal character; Python's `json.dumps` escapes that
 * same character to the six ASCII bytes `\u2014`. Both round-trip losslessly, so
 * a one-line semantic change lands as a whole-file re-encoding. It happened on
 * PR #1127: a diff of +132/-65 whose real content was +68/-1 — roughly half
 * the lines were the same characters respelled.
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

  // ── the two crossing axes: kind and audience ────────────────────────────
  //
  // How a channel crosses the wire is DECLARED, never defaulted. The classes
  // these replace were honest one at a time and dishonest as a set:
  // `bridgedBroadcasts` meant both "crosses as fan-out" and "every default
  // client auto-subscribes", `outboundCommands` held three shapes under one
  // label, and `inProcess` said "never crosses" for channels delivered to
  // browsers per resource scope every day.
  //
  // `kind` is the wire-crossing shape (operation | command | event) and is
  // spelled `kind` rather than `shape` because `channels[]` entries already
  // use `shape` for the PAYLOAD shape. `audience` is who receives it
  // (everyone | scoped | declared).
  //
  // An OPERATION channel declares neither: both follow from `operations`, and
  // restating a derivable fact is a mirror with nothing to gate it.
  const KINDS = ['command', 'event'];
  const AUDIENCES = ['everyone', 'scoped', 'declared'];

  const axisOwner = (axis, values) => {
    const owner = new Map();
    for (const value of values) {
      const list = axis?.[value] ?? [];
      const seen = new Set();
      for (const ch of list) {
        known(ch, `${axis === reg.kind ? 'kind' : 'audience'}.${value}`);
        if (seen.has(ch)) problems.push(`${value} lists "${ch}" more than once`);
        seen.add(ch);
        const prior = owner.get(ch);
        if (prior) {
          problems.push(
            `"${ch}" is declared BOTH ${prior} and ${value} — a channel crosses exactly one way`,
          );
        } else {
          owner.set(ch, value);
        }
      }
    }
    return owner;
  };

  const kindOf = axisOwner(reg.kind, KINDS);
  const audienceOf = axisOwner(reg.audience, AUDIENCES);
  const inProcessSet = new Set(reg.inProcess?.channels ?? []);

  // An operation's channels are classified by derivation; hand-listing one
  // lets the two disagree, and nothing would say which is right.
  const operationChannels = new Set();
  for (const op of reg.operations) {
    operationChannels.add(op.request);
    operationChannels.add(op.result);
    operationChannels.add(op.failure);
    if (op.progress) operationChannels.add(op.progress);
  }
  for (const ch of operationChannels) {
    if (kindOf.has(ch)) {
      problems.push(`"${ch}" belongs to an operation, so its kind is derived — remove it from kind.${kindOf.get(ch)}`);
    }
    if (audienceOf.has(ch)) {
      problems.push(`"${ch}" belongs to an operation, so its audience is derived — remove it from audience.${audienceOf.get(ch)}`);
    }
  }

  // `inProcess` means it never crosses. An audience means it does.
  for (const ch of inProcessSet) {
    if (audienceOf.has(ch)) {
      problems.push(`"${ch}" is declared inProcess but also given audience.${audienceOf.get(ch)} — inProcess means it never crosses`);
    }
    if (kindOf.has(ch)) {
      problems.push(`"${ch}" is declared inProcess but also given kind.${kindOf.get(ch)} — inProcess means it never crosses`);
    }
  }

  // No fallthrough: a channel that is neither in-process nor part of an
  // operation crosses the wire, and must say how and to whom.
  for (const c of reg.channels) {
    const ch = c.channel;
    if (inProcessSet.has(ch) || operationChannels.has(ch)) continue;
    if (!kindOf.has(ch)) {
      problems.push(
        `channel "${ch}" declares no kind — add it to kind.command or kind.event, ` +
          `or to inProcess if it never crosses. There is no default.`,
      );
    }
    if (!audienceOf.has(ch)) {
      problems.push(
        `channel "${ch}" declares no audience — add it to audience.everyone, ` +
          `audience.scoped or audience.declared. There is no default.`,
      );
    }
  }

  // ── effect: does emitting this channel CHANGE anything? ─────────────────
  //
  // The domain is the EMITTABLE set — an operation's request, or a
  // `kind: command`. Nothing else: a reply, a broadcast event and an
  // in-process UI signal are never emitted at the gateway, so the question
  // does not arise for them.
  //
  // Every member names one side and there is no default, because the gateway
  // reads this to decide whether an emit was an ACT. A channel that fell
  // through would read as "not an act" and quietly stop the record from ever
  // learning that person's name (PERSON-PROFILE D3) — the same silent shape
  // as the direction fallthrough that starved every worker.
  const emittable = new Set([...reg.operations.map((op) => op.request), ...(reg.kind?.command ?? [])]);
  const effectOf = new Map();
  for (const side of ['writes', 'reads']) {
    const seen = new Set();
    for (const ch of reg.effect?.[side] ?? []) {
      known(ch, `effect.${side}`);
      if (seen.has(ch)) problems.push(`effect.${side} lists "${ch}" more than once`);
      seen.add(ch);
      const prior = effectOf.get(ch);
      if (prior) {
        problems.push(`"${ch}" is declared BOTH effect.${prior} and effect.${side} — an emit either changes the knowledge base or it does not`);
      } else {
        effectOf.set(ch, side);
      }
      if (!emittable.has(ch)) {
        problems.push(
          `effect.${side} names "${ch}", which nobody emits — the domain is ` +
            `an operation's request or a kind.command`,
        );
      }
    }
  }
  for (const ch of emittable) {
    if (!effectOf.has(ch)) {
      problems.push(
        `emittable channel "${ch}" declares no effect — add it to effect.writes ` +
          `or effect.reads. There is no default.`,
      );
    }
  }

  // A directive for whichever single handler owns it, broadcast to every
  // default client, is a combination no member wants. Refuse it rather than
  // leave it expressible and untested.
  for (const [ch, kind] of kindOf) {
    if (kind === 'command' && audienceOf.get(ch) === 'everyone') {
      problems.push(`"${ch}" is kind=command with audience=everyone — a directive is not a broadcast`);
    }
  }

  // ── a stored event's ts is its shape, event and enrichment, spelled out ─
  // `ts` is emitted verbatim into EventMap, so it restates facts the entry
  // already declares. Hold it to them: a channel marked `enriched` whose ts
  // still says StoredEvent types every subscriber as if the EventStore attached
  // nothing, and producer and consumer go back to casting across the gap.
  for (const c of reg.channels) {
    if (c.enriched !== undefined && (c.enriched !== true || c.shape !== 'storedEvent')) {
      problems.push(`"${c.channel}" sets enriched: ${JSON.stringify(c.enriched)} — it is a flag (true or absent), and only a stored event can carry it`);
    }
    if (c.shape !== 'storedEvent') continue;
    const expected = `${c.enriched === true ? 'EnrichedEvent' : 'StoredEvent'}<EventOfType<'${c.event}'>>`;
    if (c.ts !== expected) {
      problems.push(`"${c.channel}" is a${c.enriched === true ? 'n enriched' : ''} stored event, so its ts must be ${expected} — found ${c.ts}`);
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
