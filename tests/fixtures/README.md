# Shared fixture generation

`scripts/make-pdf-fixtures.py` writes deterministic PDF extraction fixtures into
`specs/src/smelter/fixtures/`. `scripts/make-legible-scan.py` writes a raster PDF to
a supplied output path; the Smelter cases and end-to-end tests share its content.
Executable tools live here; their declarative fixtures remain with the specification.
