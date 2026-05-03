# CLI cheatsheet

The `semiont` CLI is a **thin wrapper** over the `@semiont/sdk` TypeScript surface. Every CLI command corresponds to one or more SDK calls; the CLI exists for ad-hoc, one-off, or shell-pipeline use cases. **The SDK is the primary interface.** Skills, tools, and applications should be built against `@semiont/sdk` directly — the per-skill docs in this directory all show SDK code as the canonical recipe.

This cheatsheet exists for: quick interactive testing, shell scripts that don't justify a full TypeScript project, and one-off operations during development. For anything that will be re-run, automated, or composed with other skills, write the SDK version.

## Setup

```bash
semiont login                              # interactive: prompts for email + password
semiont login --email a@example.com --password '...'
```

Token is cached locally; subsequent commands reuse it. Run `semiont login` again to refresh.

## Single-pass detection (Layer #2)

The four motivations are exposed as `--motivation` flags on `semiont mark`. Each corresponds to its own SDK skill — see the per-skill docs for full context.

| Operation | CLI | SDK skill |
|---|---|---|
| Add commenting annotations | `semiont mark --resource <id> --delegate --motivation commenting [--tone scholarly\|explanatory\|conversational\|technical] [--instructions "..."] [--density 2-12]` | [`semiont-comment`](semiont-comment/SKILL.md) |
| Add highlighting annotations | `semiont mark --resource <id> --delegate --motivation highlighting [--instructions "..."] [--density 1-15]` | [`semiont-highlight`](semiont-highlight/SKILL.md) |
| Add assessment annotations | `semiont mark --resource <id> --delegate --motivation assessing [--tone analytical\|critical\|balanced\|constructive] [--instructions "..."] [--density 1-10]` | [`semiont-assess`](semiont-assess/SKILL.md) |
| Add tagging annotations | `semiont mark --resource <id> --delegate --motivation tagging [--instructions "..."]` | [`semiont-tag`](semiont-tag/SKILL.md) |
| Add a manual annotation (any motivation) | `semiont mark --resource <id> --motivation <m> --selector-quote "..." --body "..."` | (any) |

## Browse

| Operation | CLI |
|---|---|
| Find a resource by name | `semiont browse resources --search "<name>"` |
| List all resources | `semiont browse resources` |
| Inspect one resource | `semiont browse resource <id>` |
| List annotations on a resource | `semiont browse resource <id> --annotations` |
| List the KB's published entity-type vocabulary | `semiont browse entity-types` |

## Yield (create resources)

| Operation | CLI | SDK skill |
|---|---|---|
| Upload a file as a resource | `semiont yield --file <path> --name "<name>" --format <media-type> --entity-types Tag1,Tag2` | [`semiont-ingest`](semiont-ingest/SKILL.md) |
| Move / rename a resource | `semiont mv <fromUri> <toUri>` | — |

For corpus-wide ingest (declaring the vocabulary via `frame.addEntityTypes` then yielding many files), use the SDK — see [`semiont-ingest`](semiont-ingest/SKILL.md). The CLI's per-file `yield` is right for one-off uploads.

## Match, gather, bind

These verbs are foundational to canonicalize-mentions skills (Layer #3 construction). They are usually composed into a TypeScript loop rather than invoked one at a time from the shell — but the CLI surfaces are useful for ad-hoc testing.

| Operation | CLI | SDK skill |
|---|---|---|
| Search for matches against an annotation's context | `semiont match --resource <rid> --annotation <aid>` | [`semiont-wiki`](semiont-wiki/SKILL.md) |
| Gather LLM context for an annotation | `semiont gather --resource <rid> --annotation <aid>` | [`semiont-wiki`](semiont-wiki/SKILL.md) |
| Bind a body item to an annotation | `semiont bind --resource <rid> --annotation <aid> --add-resource <targetRid>` | [`semiont-wiki`](semiont-wiki/SKILL.md) |

The full canonicalize-mentions loop (`browse → gather → match → bind / yield.fromAnnotation`) is best written as a TypeScript script — see [`semiont-wiki`](semiont-wiki/SKILL.md).

## Wire the edges (Layer #4)

After the node set exists (Layer #3 populated by `semiont-wiki` or another canonicalize-mentions pass), a second `mark.assist` linking pass with relationship-vocabulary instructions discovers the edges between nodes.

| Operation | CLI | SDK skill |
|---|---|---|
| Run a relationship-extraction pass | `semiont mark --resource <id> --delegate --motivation linking --instructions "Tag relationships between named entities..."` | [`semiont-relate`](semiont-relate/SKILL.md) |

The CLI works for ad-hoc testing on one document, but real edge-extraction over a corpus benefits from the SDK's structured handling of the two encoding shapes (inline tagging body vs. synthesized Relationship resources) — see [`semiont-relate`](semiont-relate/SKILL.md).

## Other operations

| Operation | CLI | Notes |
|---|---|---|
| Direct attention to an annotation (cross-participant beckon) | `semiont beckon <resourceId> --annotation <annotationId>` | Frontend coordination signal; cf. [`docs/protocol/flows/BECKON.md`](../flows/BECKON.md). |
| Add a user | `semiont useradd --email <e> --role <r>` | Admin-only. |
| Listen on a channel | `semiont listen <channel>` | Streams bus events. |
| Watch a resource | `semiont watch <resourceId>` | Live view of resource + annotations. |

## When to reach for the SDK instead

- The script will be re-run regularly (write it once, run it forever).
- Multiple verbs compose into a loop (e.g., the canonicalize-mentions loop).
- The script will be packaged with a KB repo as a long-term artifact.
- Type safety, error handling, or tier-3 interactive checkpoints matter.
- The operation is one of the structural archetypes — *Ingest* ([`semiont-ingest`](semiont-ingest/SKILL.md)), *Single-pass detection* ([`semiont-comment`](semiont-comment/SKILL.md), [`semiont-highlight`](semiont-highlight/SKILL.md), [`semiont-assess`](semiont-assess/SKILL.md), [`semiont-tag`](semiont-tag/SKILL.md)), *Canonicalize mentions* ([`semiont-wiki`](semiont-wiki/SKILL.md)), *Wire the edges* ([`semiont-relate`](semiont-relate/SKILL.md)), or *Compose aggregates* ([`semiont-aggregate`](semiont-aggregate/SKILL.md)). Each has an SDK-based skill in this directory.

The CLI is thin on purpose. The substrate is the SDK.
