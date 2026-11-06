#!/usr/bin/env node
// Haskell's refresh actions come from the common table. Subject paths come
// from the reference SDK's typed extractors; unread syntax fails generation.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readCacheRefresh } from './cache-refresh-table.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TABLE = resolve(ROOT, 'protocol/specs/src/client/refresh.json');
const fail = (message) => { throw new Error(message); };
const { queries, refresh, whens } = readCacheRefresh(TABLE, resolve(ROOT, 'protocol/specs/src/bus/registry.json'), resolve(ROOT, 'protocol/specs/src/openapi.json'), fail);
const reference = resolve(ROOT, 'packages/typescript/sdk/src/cache-refresh.ts');
const source = ts.createSourceFile(reference, readFileSync(reference, 'utf8'), ts.ScriptTarget.Latest, true);
const unparen = (node) => ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
const identifier = (name) => name[0].toUpperCase() + name.slice(1);
const quote = (value) => JSON.stringify(value);
const list = (values) => `[${values.join(', ')}]`;
const optional = (value, emit) => value === undefined ? 'Nothing' : `(Just ${emit(value)})`;
const path = (node, parameter) => {
  if (ts.isIdentifier(node) && node.text === parameter) return [];
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken === undefined) return [...path(node.expression, parameter), node.name.text];
  return fail(`unread subject path: ${node.getText(source)}`);
};
const pathLiteral = (value) => list(value.map(quote));
let labels;
const subject = (node, parameter) => {
  node = unparen(node);
  if (!ts.isObjectLiteralExpression(node)) return fail(`unread subject: ${node.getText(source)}`);
  const values = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return fail('subject gained a computed or spread member');
    const key = property.name.text;
    if (!['when', 'resource', 'annotation', 'written'].includes(key) || values.has(key)) return fail(`unread subject member: ${key}`);
    if (key === 'when') {
      if (!ts.isStringLiteral(property.initializer)) return fail('subject when is not literal');
      values.set(key, property.initializer.text);
    } else values.set(key, path(property.initializer, parameter));
  }
  labels.push(values.get('when'));
  return `Paths ${optional(values.get('when'), quote)} ${['resource','annotation','written'].map((key) => optional(values.get(key), pathLiteral)).join(' ')}`;
};
let object;
for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === 'SUBJECT_OF') object = declaration.initializer;
}
if (!object || !ts.isObjectLiteralExpression(object)) fail('reference SDK has no SUBJECT_OF object');
const extractors = new Map();
for (const property of object.properties) {
  if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isArrowFunction(property.initializer)) fail('unread subject extractor');
  const trigger = property.name.text;
  const fn = property.initializer;
  if (fn.parameters.length > 1 || fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) fail('unread subject extractor parameters');
  const parameter = fn.parameters[0]?.name.text;
  const body = unparen(fn.body);
  let expression;
  labels = [];
  if (ts.isConditionalExpression(body)) expression = `Present ${pathLiteral(path(body.condition, parameter))} (${subject(body.whenTrue, parameter)}) (${subject(body.whenFalse, parameter)})`;
  else expression = `Direct (${subject(body, parameter)})`;
  const expectedLabels = whens.get(trigger);
  if (!expectedLabels || labels.length !== expectedLabels.length || new Set(labels).size !== labels.length || expectedLabels.some((label) => !labels.includes(label))) fail(`subject conditions differ from the table: ${trigger}`);
  if (extractors.has(trigger)) fail(`duplicate subject extractor: ${trigger}`);
  extractors.set(trigger, expression);
}
const expected = [...whens.keys()].filter((trigger) => trigger !== 'reopened');
if (extractors.size !== expected.length || expected.some((trigger) => !extractors.has(trigger))) fail('reference subject extractors differ from refresh triggers');
const query = (name) => {
  if (!queries.some((candidate) => candidate.name === name)) return fail(`unknown refresh query: ${name}`);
  return identifier(name);
};
const rows = refresh.map((row) => `Row ${quote(row.on)} ${optional(row.when, quote)} ${row.reach === 'held' ? 'Held' : 'Subject'} ${['refetches','writes','removes'].map((key) => list((row[key] ?? []).map(query))).join(' ')}`);
const text = `-- Generated from client/refresh.json and the typed SUBJECT_OF reference. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CacheRefresh (Query(..), Reach(..), Row(..), Paths(..), Extractor(..), rows, extractors) where
import Data.Text (Text)
import qualified Data.Map.Strict as Map
data Query = ${queries.map((value) => query(value.name)).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
data Reach = Subject | Held deriving (Eq, Show)
data Row = Row Text (Maybe Text) Reach [Query] [Query] [Query] deriving (Eq, Show)
data Paths = Paths (Maybe Text) (Maybe [Text]) (Maybe [Text]) (Maybe [Text]) deriving (Eq, Show)
data Extractor = Direct Paths | Present [Text] Paths Paths deriving (Eq, Show)
rows :: [Row]
rows = ${list(rows)}
extractors :: Map.Map Text Extractor
extractors = Map.fromList ${list([...extractors].map(([trigger, expression]) => `(${quote(trigger)}, ${expression})`))}
`;
writeOrCheck(ROOT, resolve(ROOT, 'packages/haskell/sdk/generated/Semiont/Internal/Generated/CacheRefresh.hs'), text, process.argv.includes('--check'));
