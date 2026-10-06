#!/usr/bin/env node
// Generate the Python SDK's cache-refresh table from specs/src/client/refresh.json:
// which live queries each event on the bus, and the reopening of a dropped
// stream, asks again for, writes, or removes.
//
//   packages/sdk-python/src/semiont/refresh.py
//
// The reading of the table, and the account it is held to, are
// cache-refresh-table.mjs's, shared with the TypeScript generator. The output
// is committed; `--check` compares without writing (the CI drift gate).
//
// `--table <path>` and `--out <path>` name another table and another output.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh } from './cache-refresh-table.mjs';
import { writeOrCheck } from './committed-source.mjs';
import { pyBanner, pyComment, pyString } from './python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const TABLE = resolve(option('--table') ?? resolve(ROOT, 'specs/src/client/refresh.json'));
const OUT = resolve(option('--out') ?? resolve(ROOT, 'packages/sdk-python/src/semiont/refresh.py'));
const CHECK = process.argv.includes('--check');

function refuse(message) {
  console.error(`✗ ${TABLE}: ${message}`);
  process.exit(1);
}

const { queries, refresh, whens, WHEN, ACTS } = readCacheRefresh(TABLE, resolve(ROOT, 'specs/src/bus/registry.json'), refuse);

/** A tuple of strings, as Python writes one: `("a",)`, never `("a")`. */
const tuple = (values) => (values.length === 0 ? '()' : `(${values.map(pyString).join(', ')}${values.length === 1 ? ',' : ''})`);

const rowOf = (row) => {
  const said = [`reach=${pyString(row.reach ?? 'subject')}`];
  for (const act of ACTS) if ((row[act] ?? []).length > 0) said.push(`${act}=${tuple(row[act])}`);
  if (row.when !== undefined) said.push(`when=${pyString(row.when)}`);
  return `CacheRefresh(${said.join(', ')})`;
};

const triggers = [...whens.keys()];
const entries = triggers.map((on) => {
  const rows = refresh.filter((row) => row.on === on);
  const docs = rows.length === 1 ? rows[0].docs : rows.map((row) => `${row.when}: ${row.docs}`).join(' ');
  return `${pyComment(docs, '        ')}\n        ${pyString(on)}: (\n${rows.map((row) => `            ${rowOf(row)},`).join('\n')}\n        ),`;
});

const literal = (values, indent = '    ') => values.map((value) => `${indent}${pyString(value)},`).join('\n');

const text = `${pyBanner('specs/src/client/refresh.json', 'scripts/spec/generate-cache-refresh-python.mjs')}
"""What a Semiont client asks again for, and when.

A client's live queries answer from a cache. This table says what each event
on the bus, and the reopening of a dropped stream, does to it: which queries
are asked for again, which are written with what the event carries, and which
are gone.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, Literal, final

__all__ = [
    "CACHE_QUERIES",
    "CACHE_REFRESH",
    "CacheQuery",
    "CacheRefresh",
    "CacheRefreshReach",
    "CacheRefreshTrigger",
    "CacheRefreshWhen",
]

# The live queries a client's cache answers.
type CacheQuery = Literal[
${queries.map((query) => `${pyComment(query.docs, '    ')}\n    ${pyString(query.name)},`).join('\n')}
]

CACHE_QUERIES: Final[tuple[CacheQuery, ...]] = (
${literal(queries.map((query) => query.name))}
)

# Which of a split channel's two kinds of event a row is for.
type CacheRefreshWhen = Literal[${WHEN.map(pyString).join(', ')}]

# \`subject\`: the keys the event names. \`held\`: every key the client holds.
type CacheRefreshReach = Literal["subject", "held"]

# What each trigger is: a channel whose events are it, or \`reopened\`, the
# stream open again after a drop.
type CacheRefreshTrigger = Literal[
${literal(triggers)}
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CacheRefresh:
    """What one trigger does to the cache."""

    reach: CacheRefreshReach
    refetches: tuple[CacheQuery, ...] = ()
    """Asked for again, the value shown meanwhile."""
    writes: tuple[CacheQuery, ...] = ()
    """Written with the value the event carries."""
    removes: tuple[CacheQuery, ...] = ()
    """Gone: the key fails as \`bus.not-found\`."""
    when: CacheRefreshWhen | None = None


CACHE_REFRESH: Final[Mapping[CacheRefreshTrigger, tuple[CacheRefresh, ...]]] = MappingProxyType(
    {
${entries.join('\n')}
    }
)
`;

writeOrCheck(ROOT, OUT, text, CHECK);
