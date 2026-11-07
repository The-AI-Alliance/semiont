#!/usr/bin/env node
// Haskell's refresh table, from protocol/specs/src/client/refresh.json alone:
// each row's acts, and the ways to what its event names.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheRefresh, REOPENED, UNREADABLE } from './cache-refresh-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/client/refresh.json');
const fail = (message) => { throw new Error(message); };
const { queries, refresh, channelTriggers } = readCacheRefresh(ROOT, TABLE, fail);
const identifier = (name) => name[0].toUpperCase() + name.slice(1);
const quote = (value) => JSON.stringify(value);
const list = (values) => `[${values.join(', ')}]`;
const optional = (value, emit) => value === undefined ? 'Nothing' : `(Just ${emit(value)})`;
const way = (dotted) => list(dotted.split('.').map(quote));
const ways = ({ names = {}, carries }) => `(Ways ${[names.resource, names.annotation, carries].map((value) => optional(value, way)).join(' ')})`;
const rows = refresh.map((row) => `Row ${quote(row.on)} ${optional(row.when, quote)} ${row.reach === 'held' ? 'Held' : 'Subject'} ${ways(row)} ${['refetches','writes','removes'].map((key) => list((row[key] ?? []).map(identifier))).join(' ')}`);
const text = `-- Generated from client/refresh.json. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CacheRefresh (Query(..), Reach(..), Ways(..), Row(..), rows, channels, reopened, unreadable) where
import Data.Text (Text)
data Query = ${queries.map((value) => identifier(value.name)).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
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
