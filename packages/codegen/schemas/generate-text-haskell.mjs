#!/usr/bin/env node
// Encoding labels/byte maps and media capabilities are owned by these shared
// tables. Preserve their order and reject a new kind of encoding case.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { readMediaTypeTable } from './media-type-table.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECK = process.argv.includes('--check');
const table = JSON.parse(readFileSync(resolve(ROOT, 'protocol/specs/src/text/encoding-cases.json'), 'utf8'));
const literal = (value) => '"'+Array.from(value).map((character) => {
 const code=character.codePointAt(0);
 return character==='"'||character==='\\'?'\\'+character:code>=32&&code<=126?character:'\\x'+code.toString(16)+'\\&';
}).join('')+'"';
const list = (values) => '['+values.join(', ')+']';
const encodingOf = new Map(), singleByte = [], refused = [];
for (const row of table.cases) {
 if (!Array.isArray(row.labels)||!row.labels.includes(row.encoding)) throw Error('encoding does not name its labels');
 for(const label of row.labels){if(encodingOf.has(label))throw Error('duplicate encoding label');encodingOf.set(label,row.encoding);}
 if(typeof row.everyByte==='string'){
  if(Array.from(row.everyByte).length!==256)throw Error('single-byte table must map every byte');
  singleByte.push(`(${literal(row.encoding)}, Vector.fromList ${list(Array.from(row.everyByte).map(c=>String(c.codePointAt(0))))})`);
 }else if(row.refused===true)refused.push(literal(row.encoding));
 else if(typeof row.bytes!=='string'||typeof row.text!=='string')throw Error('unread encoding case');
}
const {table: media,rows}=readMediaTypeTable(resolve(ROOT,'protocol/specs/src/media-types/registry.json'),resolve(ROOT,'protocol/specs/src/components/schemas/SupportedMediaType.json'));
const constructor=value=>value.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join('');
const text=`-- Generated from text/encoding-cases.json and media-types/registry.json. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.Text (encodingOf, singleByte, refused, TextSource(..), textSourceName, mediaTypes, extensions, aliases) where
import Data.Text (Text)
import Data.Aeson (FromJSON(..), ToJSON(..), Value(String), withText)
import qualified Data.Map.Strict as Map
import qualified Data.Vector as Vector
encodingOf :: Map.Map Text Text
encodingOf = Map.fromList ${list([...encodingOf].map(([label,encoding])=>`(${literal(label)}, ${literal(encoding)})`))}
singleByte :: Map.Map Text (Vector.Vector Int)
singleByte = Map.fromList ${list(singleByte)}
refused :: [Text]
refused = ${list(refused)}
data TextSource = ${media.textSource.map(constructor).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
instance ToJSON TextSource where toJSON = String . textSourceName
instance FromJSON TextSource where
  parseJSON = withText "TextSource" $ \\value -> case value of
${media.textSource.map(name=>`    ${literal(name)} -> pure ${constructor(name)}`).join('\n')}
    _ -> fail "unknown text source"
textSourceName :: TextSource -> Text
${media.textSource.map(name=>`textSourceName ${constructor(name)} = ${literal(name)}`).join('\n')}
mediaTypes :: Map.Map Text (Text,TextSource,Bool)
mediaTypes = Map.fromList ${list(rows.map(row=>`(${literal(row.mediaType)}, (${literal(row.extension)}, ${constructor(row.textSource)}, ${row.authorable?'True':'False'}))`))}
extensions :: [(Text,Text)]
extensions = ${list(rows.map(row=>`(${literal(row.extension)}, ${literal(row.mediaType)})`))}
aliases :: Map.Map Text Text
aliases = Map.fromList ${list(Object.entries(media.extensionAliases).map(([alias,extension])=>`(${literal(alias)}, ${literal(extension)})`))}
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/Text.hs'),text,CHECK);
