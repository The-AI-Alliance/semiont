# Linked Data Exchange — retired

**This format no longer exists.** `semiont-linked-data` was a JSON-LD interchange archive —
current state only, lossy on resource ids, with its own manifest and validators — reached through
`/api/moderate/exchange/{export,import}` and a Moderation GUI page.

All of it was removed in EXPORT-VIA-LAUNCHER (2026-08-27): the GUI in P1, the routes and SDK calls
in P2, the TypeScript reader and writer in P3. No archive of this format is known to exist and
nothing in the codebase reads or writes it.

## What replaced it, and what did not

**Backup and restore** are now launcher verbs — `semiont export` / `semiont import` — described in
[BACKUP.md](../system/administration/BACKUP.md). They are **not** a replacement for this format,
and the difference is the point:

| | `semiont-linked-data` (retired) | `semiont export` |
|---|---|---|
| Purpose | interchange with standards tooling | backup and migration |
| Content | current state, JSON-LD | the KB directory, unmodified |
| Fidelity | lossy — new ids on import | lossless — byte-identical round-trip |
| Format | manifest, version, validators | none; it is a `tar.gz` of files |

So **the interoperability use case is currently unserved.** Exporting a corpus as W3C Web
Annotation / Schema.org JSON-LD for other Linked Data tooling is not something Semiont does today.
That is a deliberate consequence of retiring the format rather than a gap someone forgot: the
format's only surface was an API this project decided exchange should not have, and no user had
asked for the interchange half.

If it comes back, it should come back as a launcher verb reading the working tree, and it should
be designed fresh — the retired implementation's shape was constrained by the HTTP surface it
travelled over, which no longer exists.

## Why this page still exists

So that "where did Linked Data export go?" has an answer, and so the distinction above is written
down somewhere: a lossless directory tarball and a standards-based interchange format solve
different problems, and having the first does not mean the second was delivered.

**Related**: [Backup & Restore](../system/administration/BACKUP.md) | [System Documentation](../system/README.md)
