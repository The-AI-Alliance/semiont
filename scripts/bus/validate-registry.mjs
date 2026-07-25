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
