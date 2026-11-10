#!/usr/bin/env node
// Haskell's refresh table, from protocol/specs/src/client/refresh.json alone:
// each row's acts, and the ways to what its event names.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh, REOPENED, UNREADABLE } from './cache-refresh-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/client/refresh.json');
const fail = (message) => { throw new Error(message); };
const { queries, values, refresh, channelTriggers } = readCacheRefresh(ROOT, TABLE, fail);
const identifier = (name) => name[0].toUpperCase() + name.slice(1);
const quote = (value) => JSON.stringify(value);
const list = (values) => `[${values.join(', ')}]`;
const optional = (value, emit) => value === undefined ? 'Nothing' : `(Just ${emit(value)})`;
const way = (dotted) => list(dotted.split('.').map(quote));
const ways = ({ names = {}, carries }) => `(Ways ${[names.resource, names.annotation, carries].map((value) => optional(value, way)).join(' ')})`;
const SCHEMAS = resolve(ROOT, 'protocol/specs/src/components/schemas');
const component = (name) => JSON.parse(readFileSync(resolve(SCHEMAS, `${name}.json`), 'utf8'));
/** The component a schema's `$ref` names, `./Name.json` or `Name.json`; undefined for a schema that is no `$ref`. */
const referred = (schema) => /^(?:\.\/)?([A-Za-z0-9]+)\.json$/.exec(schema.$ref ?? '')?.[1];
/** The models the value types name, each imported once. */
const models = new Set();
const model = (name) => { models.add(name); return name; };
/** The Haskell type of a member's schema: a model, a list of them, or a list of Text. */
const haskellTypeOf = (schema, label) => {
  const named = referred(schema);
  if (named !== undefined) return model(named);
  if (schema.type === 'array' && schema.items !== undefined) return `[${haskellTypeOf(schema.items, label)}]`;
  if (schema.type === 'string') return 'Text';
  fail(`${label} is of ${JSON.stringify(schema)}, which this generator writes no Haskell type for`);
};
/** The Haskell type of the value a query's cache holds: its `value`'s component, or the member within it. */
const valueType = (name) => {
  const { component: named, members } = values.get(name);
  if (members.length === 0) return model(named);
  let holder = component(named);
  for (const member of members.slice(0, -1)) {
    const inner = holder.properties[member];
    const next = referred(inner);
    holder = next === undefined ? inner : component(next);
  }
  return haskellTypeOf(holder.properties[members.at(-1)], `the value of the query ${name}`);
};
const valueTypes = queries.map((query) => `type ${identifier(query.name)}Value = ${valueType(query.name)}`);
const rows = refresh.map((row) => `Row ${quote(row.on)} ${optional(row.when, quote)} ${row.reach === 'held' ? 'Held' : 'Subject'} ${ways(row)} ${['refetches','writes','removes'].map((key) => list((row[key] ?? []).map(identifier))).join(' ')}`);
const text = `-- Generated from client/refresh.json. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CacheRefresh (Query(..), ${queries.map((value) => `${identifier(value.name)}Value`).join(', ')}, Reach(..), Ways(..), Row(..), rows, channels, reopened, unreadable) where
import Data.Text (Text)
${[...models].sort().map((name) => `import Semiont.Internal.Generated.Models.${name} (${name})`).join('\n')}
data Query = ${queries.map((value) => identifier(value.name)).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
-- | The type of the value each live query's cache holds for a key: the table's \`value\`, a component or a member
-- within one.
${valueTypes.join('\n')}
data Reach = Subject | Held deriving (Eq, Show)
-- | Where in its event a row finds the resource it names, the annotation it names, and the value it carries.
data Ways = Ways (Maybe [Text]) (Maybe [Text]) (Maybe [Text]) deriving (Eq, Show)
data Row = Row Text (Maybe Text) Reach Ways [Query] [Query] [Query] deriving (Eq, Show)
rows :: [Row]
rows = ${list(rows)}
-- | The triggers that are channels of the bus.
channels :: [Text]
channels = ${list(channelTriggers.map(quote))}
reopened, unreadable :: Text
reopened = ${quote(REOPENED)}
unreadable = ${quote(UNREADABLE)}
`;
writeOrCheck(ROOT, resolve(ROOT, 'packages/haskell/sdk/generated/Semiont/Internal/Generated/CacheRefresh.hs'), text, process.argv.includes('--check'));
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/conformance/LiveQueries.hs'),`-- Generated from client/refresh.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module LiveQueries (LiveQuery(..)) where
import Data.Aeson (FromJSON(..), withText)
data LiveQuery = ${queries.map(value=>identifier(value.name)).join(' | ')} deriving (Eq, Show)
instance FromJSON LiveQuery where
  parseJSON = withText "LiveQuery" $ \\value -> case value of
${queries.map(({name})=>`    ${quote(name)} -> pure ${identifier(name)}`).join('\n')}
    _ -> fail "unknown live query"
`,process.argv.includes('--check'));
