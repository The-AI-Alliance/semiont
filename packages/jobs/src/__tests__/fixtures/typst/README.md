# Typst citation fixtures

Source documents for the PDF-generation citation branch. Each one forces a
specific way that **rendered text diverges from the source text a model cited**,
which is the problem the citation search layer exists to solve.

Every file carries a header comment stating what it forces and the geometry it
produced when measured. Read those first; this file covers only what is common.

## These are sources, not artifacts

**The compiled PDFs are not committed.** `packages/content` establishes the
convention — `src/__tests__/generate-fixtures.ts` builds its PDF fixtures at
test time through a vitest `globalSetup`, so fixtures stay reviewable as code
rather than opaque binaries. There are no committed binary fixtures anywhere in
this repo, and these should not be the first.

Compiling them needs the Typst binary, which arrives with the worker image in
PDF-GENERATION P2. **Until then these files are inert** — a generation step
alongside them is P4's work, mirroring `generate-fixtures.ts`.

## Compiling

```
typst compile --creation-timestamp 1700000000 plain.typ plain.pdf
```

**The timestamp pin is mandatory, not stylistic.** Typst writes `CreationDate`
and `ModDate`, so unpinned compiles of identical source produce different bytes
every time. Different bytes mean a different content checksum, which makes the
Smelter re-embed a document that did not change — the spurious-re-embed failure
smelter axioms S11/S12 exist to prevent. Measured 2026-08-04: unpinned compiles
differ, pinned compiles are byte-identical. The flag also honours
`SOURCE_DATE_EPOCH`.

## Nothing about the page is set

No `#set page`, no font, no margins. Every recorded number comes from Typst
0.15.1 defaults, which is what makes them reproducible:

| | |
|---|---|
| Page | `595.2756 x 841.8898` pt (A4) |
| Left margin | `70.866` pt (2.5 cm) — the `x=71` in every recorded rect |
| Body / heading | 11 pt / 15.4 pt |

Do not add page settings to these files. The defaults *are* the fixture: change
them and every recorded assertion moves.

If a compile does not put `"quick brown"` at the end of line 1 of `plain.typ`,
that is a Typst version difference rather than a settings one — check the
version before assuming a regression.

## Where the reasoning lives

Findings, the two-stage search design these fixtures test, and the untracked
spike harness that produced them are in `.plans/PDF-GENERATION.md`. That
document is not in the repo; these fixtures are self-describing on purpose.
