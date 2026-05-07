# Projection Pattern — functional core, imperative shell

This doc explains how Semiont's `__system__`-stream projections (the
files under `<stateDir>/projections/__system__/`) are written and read.
The pattern is **functional core, imperative shell**:

- **Pure reducers** in `@semiont/event-sourcing` own the
  projection-update semantics — given a current view and a single
  event, return the next view.
- **Pure validators** in `@semiont/make-meaning` own the
  command-validation semantics — given a current view and a caller-
  supplied command input, decide whether the input is valid against
  the registered vocabulary.
- **I/O shells** wrap the pure functions with the disk reads/writes,
  bus emissions, and event-store appends that turn the pure logic into
  observable behavior.

The split exists so the *what* of the rules — "tag schemas dedup by
id, most-recent registration wins, identical re-registrations are
silent" — can be tested as a pure-data assertion that runs in
microseconds, separate from the *how* — "the materializer reads JSON,
the dispatcher catches errors and emits `job:create-failed`."

## The two layers

### Reducers (`@semiont/event-sourcing`)

Lives in [`packages/event-sourcing/src/views/projection-reducers.ts`](../../packages/event-sourcing/src/views/projection-reducers.ts).

Two reducers today:

| Reducer | Input | Output | Owns |
|---------|-------|--------|------|
| `applyEntityTypeAdded(view, tag)` | `string[]`, `string` | `string[]` | dedup (`Set`) + locale-aware sort |
| `applyTagSchemaAdded(view, schema)` | `TagSchema[]`, `TagSchema` | `{ next: TagSchema[]; warning?: { schemaId, message } }` | dedup-by-id + locale-aware sort + most-recent-wins + overwrite-with-different-content warning |

The shapes are deliberate. `applyEntityTypeAdded` returns a plain
array because entity types are opaque strings — there's no warning
case to surface. `applyTagSchemaAdded` returns a result struct so the
"warning when an existing id is overwritten with differing content"
signal is part of the pure-data return value, not a callback the
caller has to mock in tests.

The shell — `ViewMaterializer.materializeEntityTypes` /
`materializeTagSchemas` in
[`view-materializer.ts`](../../packages/event-sourcing/src/views/view-materializer.ts) —
is now a thin reader/writer wrapping the reducer:

```ts
async materializeTagSchemas(schema: TagSchema): Promise<void> {
  const path = ...;
  let view = { tagSchemas: [] as TagSchema[] };
  try {
    view = JSON.parse(await fs.readFile(path, 'utf-8'));
  } catch (e) { /* ENOENT — first registration */ }

  const result = applyTagSchemaAdded(view.tagSchemas, schema);
  if (result.warning) this.logger?.warn('[ViewMaterializer] Tag schema overwritten', result.warning);
  view.tagSchemas = result.next;

  await fs.writeFile(path, JSON.stringify(view, null, 2));
}
```

The reducer is the contract; the shell is the wiring.

### Validators (`@semiont/make-meaning`)

Lives in [`packages/make-meaning/src/views/projection-validators.ts`](../../packages/make-meaning/src/views/projection-validators.ts).

Two validators today:

| Validator | Input | Output | Owns |
|-----------|-------|--------|------|
| `resolveTagSchema(schemas, schemaId)` | `TagSchema[]`, `unknown` | `{ schema } \| { error }` | empty-id check, lookup-by-id, "not registered" error format |
| `validateEntityTypes(registered, requested)` | `string[]`, `string[] \| undefined` | `{ ok: true } \| { ok: false; unknown }` | empty-input no-op, set membership check, unknown-tag listing |

The shell — the `'job:create'` subscriber in
[`handlers/job-commands.ts`](../../packages/make-meaning/src/handlers/job-commands.ts) —
calls the readers (which do the I/O) then the validators (pure):

```ts
if (jobType === 'tag-annotation') {
  const schemas = await readTagSchemasProjection(project);
  const result = resolveTagSchema(schemas, jobParams.schemaId);
  if (result.error !== undefined) throw new Error(result.error);
  jobParams.schema = result.schema;
  delete jobParams.schemaId;
}
```

If the validator says `error`, the surrounding catch turns it into
`job:create-failed` on the bus. The "what counts as a valid
schemaId / entityType set" rule is the validator's; the "how does
that decision become a wire event" wiring is the shell's.

## Why this split

The pattern is a familiar one — sometimes called *functional core,
imperative shell*, sometimes *hexagonal architecture*, sometimes just
*pure-impure separation*. The specific wins for Semiont:

1. **Tests are fast and trivial.** The reducer/validator unit tests
   run in single-digit milliseconds with no filesystem, no event-bus,
   no mock JobQueue. The integration tests for the I/O shells (in
   `view-materializer.test.ts` and `local-transport.test.ts`) still
   exist — they prove the wiring works — but they're no longer where
   the projection-update *semantics* are tested.

2. **Property-based testing becomes natural.** See [Axioms](#axioms)
   below — invariants like "no duplicate ids" or "every actually-
   missing tag is reported" are exactly the shape fast-check excels
   at, and they only make sense against a pure function.

3. **Schema evolution has a natural home.** The deferred work in
   [`.plans/EVOLVE-TAG-SCHEMA.md`](../../.plans/EVOLVE-TAG-SCHEMA.md) —
   migrating a category rename, version-bumping a schema id, soft-
   deprecating a category — slots into the reducer module as
   additional pure functions on the same view shapes. No new I/O
   surface; no new actor.

4. **Re-use beyond the actor.** The validators don't depend on the
   bus or the event store. A future CLI that wants to dry-run a `KB
   lint` over the projection can call `validateEntityTypes` directly
   without spinning up the full kernel.

## Axioms

Properties the reducers and validators must obey for *any* input,
expressed as fast-check property tests. They live alongside the
example-based tests in two files:

- [`packages/event-sourcing/src/__tests__/views/projection-reducers.test.ts`](../../packages/event-sourcing/src/__tests__/views/projection-reducers.test.ts)
- [`packages/make-meaning/src/__tests__/views/projection-validators.test.ts`](../../packages/make-meaning/src/__tests__/views/projection-validators.test.ts)

The axioms below are the contracts the rest of the system relies on.
If you change a reducer or validator and an axiom test fails, you've
broken a load-bearing property — review carefully whether the change
is actually intended.

### Reducer axioms

#### `applyEntityTypeAdded(view, tag)`

| Axiom | Statement |
|-------|-----------|
| Sortedness | The output array is in `localeCompare` order. |
| Uniqueness | The output has no duplicate strings. |
| Set semantics | The output, viewed as a set, equals the unique set of inputs. |
| Idempotence | `apply(apply(s, x), x) === apply(s, x)`. |
| Order independence | Any permutation of the same input sequence yields the same projection. |
| Subset preservation | Every input tag appears in the output (no removal). |
| Length bound | `output.length === |unique inputs| ≤ inputs.length`. |

#### `applyTagSchemaAdded(view, schema)`

| Axiom | Statement |
|-------|-----------|
| Sortedness by id | `next` is sorted by `schema.id` (locale-aware). |
| Uniqueness by id | No two entries in `next` share an id. |
| Set semantics on id | The id set of `next` equals the unique id set of inputs. |
| Most-recent-wins | For every distinct id, the surviving schema is the *last* input with that id. |
| Idempotence on identical re-registration | Re-registering the exact same schema content returns an unchanged `next` and `warning === undefined`. |
| Warning iff overwrite-with-differing-content | `result.warning` is set exactly when an existing schema with the same id is being replaced by content that differs. |
| Subset preservation by id | Every input id is in the output id set. |
| Length bound | `next.length === |unique input ids| ≤ inputs.length`. |
| No mutation | The input `current` array is never modified. |

### Validator axioms

#### `resolveTagSchema(schemas, schemaId)`

| Axiom | Statement |
|-------|-----------|
| Round-trip | For any registered schema `s`, `resolveTagSchema(schemas, s.id).schema === s`. |
| Mutual exclusion | The result has either `schema` or `error`, never both, never neither. |
| Empty/non-string `schemaId` | Always produces `error: "tag-annotation requires schemaId"`. |
| Unknown non-empty `schemaId` | Always produces `error: "Tag schema not registered: <id>"`. |
| No mutation | The input `schemas` array is never modified. |

#### `validateEntityTypes(registered, requested)`

| Axiom | Statement |
|-------|-----------|
| Soundness | Every tag reported as `unknown` is genuinely missing from `registered`. |
| Completeness | Every tag in `requested` that is not in `registered` is reported. |
| Order preservation | `result.unknown` preserves the order of `requested`. |
| Reflexivity | `validateEntityTypes(s, s)` is always `{ ok: true }`. |
| Empty/undefined `requested` | Always `{ ok: true }` regardless of `registered` (no validation triggered). |
| No mutation | Neither `registered` nor `requested` is modified. |

### When to add a new axiom

Whenever a behavior is described in a comment or in commit text as
"always ..." or "never ..." or "for any ...", that's a candidate
axiom. Three signs:

- The rule constrains the *output* given any *input* — not just specific examples.
- A counterexample to the rule would be a real bug, not a design choice.
- Hand-rolling examples won't cover the input space (e.g. "all permutations" or "all valid TagSchema values").

If those hold, write the axiom and let fast-check shrink any
violation into a small counterexample.

## Where to extend

When adding a new `__system__` projection (e.g. relation types from
the future Frame work):

1. Add a pure reducer to `projection-reducers.ts` (`applyXAdded(view, payload)`).
2. Cover it with example-based tests + at least the universal axioms (sortedness, uniqueness, idempotence on the relevant equivalence relation, set semantics, no mutation).
3. Add an I/O shell method to `ViewMaterializer` that reads the projection file, calls the reducer, and writes the result.
4. Wire the materializer arm to `ViewManager.materializeSystem` (the dispatch on `eventType`).
5. If the new projection is queried during command validation, add a pure validator in `projection-validators.ts` and call it from the dispatcher.

## Related

- [`.plans/EVOLVE-TAG-SCHEMA.md`](../../.plans/EVOLVE-TAG-SCHEMA.md) — deferred schema-evolution work; the reducer pattern is the natural home for migration commands.
- [`docs/protocol/flows/FRAME.md`](../protocol/flows/FRAME.md) — the schema-layer flow that reads/writes `__system__` projections.
- Package-level READMEs cross-reference this doc — see [`packages/event-sourcing/README.md`](../../packages/event-sourcing/README.md) and [`packages/make-meaning/README.md`](../../packages/make-meaning/README.md).
