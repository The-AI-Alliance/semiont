#!/usr/bin/env node
// Haskell's kept queries, their document and the stream's places, from protocol/specs/src/session/stored.json
// and client/refresh.json alone: the queries, the whole key and the version through kept-queries.mjs.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readKeptQueries} from './kept-queries.mjs';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fail=message=>{throw Error(message);};
const {kept,wholeKey,version}=readKeptQueries(ROOT,fail);
const stored=JSON.parse(readFileSync(resolve(ROOT,'protocol/specs/src/session/stored.json'),'utf8'));
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const onlyDescribed=schema=>Object.keys(schema).every(key=>key==='description');

// The document is rendered as a version and a list of (key, value, stamp), the stamp a Natural.
const document=stored.cacheDocument;
const entry=document?.properties?.entries?.items;
if(document?.type!=='object'||!same(Object.keys(document.properties),document.required)||document.required.length!==2
  ||document.properties.entries.type!=='array'||entry?.type!=='array'||entry.minItems!==3||entry.maxItems!==3
  ||entry.prefixItems?.length!==3||!onlyDescribed(entry.prefixItems[0])||!onlyDescribed(entry.prefixItems[1])
  ||!same(Object.keys(entry.prefixItems[2]).sort(),['description','minimum','type'])||entry.prefixItems[2].type!=='integer'||entry.prefixItems[2].minimum!==0)
  fail("stored.json's cacheDocument is not {version, entries: [[key, value, stamp]]} with a whole-number stamp of at least 0");
const [versionMember,entriesMember]=document.required;
if(document.properties[versionMember].const!==version)fail(`cacheDocument's first member, ${versionMember}, is not its version`);

// The places are rendered as a map from the type that names them to the type each is.
const places=stored.lastEventIds;
const component=reference=>{
  const match=/^\.\.\/components\/schemas\/([A-Za-z0-9]+)\.json$/.exec(reference?.$ref);
  if(match===null||Object.keys(reference).length!==1)fail(`lastEventIds names ${JSON.stringify(reference)}, not a component`);
  return match[1];
};
if(places?.type!=='object'||!Object.keys(places).every(key=>['title','type','description','propertyNames','additionalProperties'].includes(key)))
  fail("stored.json's lastEventIds is not an object of named places");
const [scope,place]=[component(places.propertyNames),component(places.additionalProperties)];

const identifier=name=>name[0].toUpperCase()+name.slice(1);
const quote=value=>JSON.stringify(value);
const generated=`-- Generated from session/stored.json and client/refresh.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CachePersistence (KeptQuery(..), keptQueryName, Whole(..), CacheDocument(..), lastEventIds) where
import Control.Monad (unless)
import Data.Aeson (FromJSON(..), ToJSON(..), Result(..), Value(..), fromJSON, object, withObject, withText, (.:), (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import Numeric.Natural (Natural)
import Semiont.Internal.Generated.Models.${place} (${place})
import Semiont.Internal.Generated.Models.${scope} (${scope})
-- | The queries a client keeps across a restart, by their names in client/refresh.json.
data KeptQuery = ${kept.map(({query})=>identifier(query)).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
keptQueryName :: KeptQuery -> Text
${kept.map(({query})=>`keptQueryName ${identifier(query)} = ${quote(query)}`).join('\n')}
-- | The key a kept query per nothing keeps its one entry under.
data Whole = Whole deriving (Eq, Ord, Show)
instance ToJSON Whole where toJSON Whole = String ${quote(wholeKey)}
instance FromJSON Whole where
  parseJSON = withText "Whole" (\\key -> if key == ${quote(wholeKey)} then pure Whole else fail "not the whole key")
-- | What a client keeps of one query: each entry's key, value and stamp. A document of another
-- version, or one whose entries are not each a key, a value and a stamp, does not decode.
newtype CacheDocument = CacheDocument [(Value, Value, Natural)] deriving (Eq, Show)
instance FromJSON CacheDocument where
  parseJSON = withObject "CacheDocument" $ \\fields -> do
    version <- fields .: ${quote(versionMember)}
    unless (version == (${version} :: Integer)) (fail "a cache document of another version")
    CacheDocument <$> fields .: ${quote(entriesMember)}
instance ToJSON CacheDocument where
  toJSON (CacheDocument entries) = object [${quote(versionMember)} .= (${version} :: Integer), ${quote(entriesMember)} .= entries]
-- | Where a stream was: a pair that is not a ${scope} and a ${place} is skipped, and a value that is no object is none.
lastEventIds :: Value -> Map.Map ${scope} ${place}
lastEventIds (Object fields) = Map.fromList
  [(named, value) | (key, raw) <- KM.toList fields, Success named <- [fromJSON (String (Key.toText key))], Success value <- [fromJSON raw]]
lastEventIds _ = Map.empty
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/CachePersistence.hs'),generated,process.argv.includes('--check'));
