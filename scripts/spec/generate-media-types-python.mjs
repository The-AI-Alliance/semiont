#!/usr/bin/env node
// generate-media-types-python.mjs — generate the Python SDK's media-type table
// from specs/src/media-types/registry.json, the registry the TypeScript, Rust
// and Go generators read.
//
//   packages/sdk-python/src/semiont/media_types_table.py
//
// Python reads the registry for the two rules specs/src/media-types/cases.json
// holds in every SDK: the format a clone takes, and the name content is
// stored under. So a row carries its media type, its extension and whether a
// person can author it, and nothing no Python code reads.
//
// --check compares without writing (the CI drift gate).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from './committed-source.mjs';
import { readMediaTypeTable } from './media-type-table.mjs';
import { pyBanner, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = resolve(ROOT, 'specs/src/media-types/registry.json');
const ENUM = resolve(ROOT, 'specs/src/components/schemas/SupportedMediaType.json');
const OUT = resolve(ROOT, 'packages/sdk-python/src/semiont/media_types_table.py');
const CHECK = process.argv.includes('--check');

const { rows } = readMediaTypeTable(TABLE, ENUM);
const pyBool = (value) => (value ? 'True' : 'False');

const text = `${pyBanner('specs/src/media-types/registry.json', 'scripts/spec/generate-media-types-python.mjs')}
"""The media types a knowledge base admits, with what this SDK reads of each."""

from dataclasses import dataclass
from typing import Final, final

__all__ = ["MEDIA_TYPES", "MediaType"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class MediaType:
    """One media type a knowledge base admits."""

    media_type: str
    extension: str
    """The extension a stored name takes, with its dot."""
    authorable: bool
    """Offered where a person writes a resource."""


# The registry, in its own order: ${rows.length} media types.
MEDIA_TYPES: Final[tuple[MediaType, ...]] = (
${rows.map((row) => `    MediaType(media_type=${pyString(row.mediaType)}, extension=${pyString(row.extension)}, authorable=${pyBool(row.authorable)}),`).join('\n')}
)
`;

writeOrCheck(ROOT, OUT, text, CHECK);
