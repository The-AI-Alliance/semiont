#!/usr/bin/env node
// Derive the persisted document and opt-in cache names from their SDK owners.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fail=message=>{throw Error(message);};
const load=file=>ts.createSourceFile(file,readFileSync(resolve(ROOT,file),'utf8'),ts.ScriptTarget.Latest,true);
const source=load('packages/typescript/sdk/src/cache-persister.ts');
const matches=source.statements.filter(node=>ts.isInterfaceDeclaration(node)&&node.name.text==='StoredDocument');
if(matches.length!==1||matches[0].heritageClauses||matches[0].typeParameters)fail('no plain persisted document');
const nativeType=node=>{
 if(node.kind===ts.SyntaxKind.NumberKeyword)return 'Scientific';
 if(node.kind===ts.SyntaxKind.UnknownKeyword)return 'Value';
 if(ts.isTupleTypeNode(node))return '('+node.elements.map(nativeType).join(',')+')';
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&node.typeName.text==='Array'&&node.typeArguments?.length===1)return '['+nativeType(node.typeArguments[0])+']';
 return fail('unread persisted document type '+node.getText(source));
};
const fields=matches[0].members.map(member=>{
 if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.questionToken||member.modifiers?.length)fail('unread persisted document member');
 return [member.name.text,nativeType(member.type)];
});
if(new Set(fields.map(([name])=>name)).size!==fields.length)fail('duplicate persisted document field');
const capitalize=name=>name[0].toUpperCase()+name.slice(1);
const browse=load('packages/typescript/sdk/src/namespaces/browse.ts');
const names=[],singletons=[];let version;
const walk=node=>{
 if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='persisted'){
  if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))fail('unread persisted cache name');
  names.push(node.arguments[0].text);
 }
 if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&['ENTITY_TYPES_KEY','TAG_SCHEMAS_KEY'].includes(node.name.text)){
  if(!node.initializer||!ts.isStringLiteral(node.initializer))fail('unread singleton key');
  singletons.push([node.name.text==='ENTITY_TYPES_KEY'?'entityTypesKey':'tagSchemasKey',node.initializer.text]);
 }
 if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='CACHE_PERSISTENCE_VERSION'){
  if(version!==undefined||!node.initializer||!ts.isNumericLiteral(node.initializer))fail('unread persistence version');
  version=node.initializer.text;
 }
 ts.forEachChild(node,walk);
};walk(browse);
if(singletons.length!==2||version===undefined||names.length===0||new Set(names).size!==names.length)fail('missing/duplicate cache persistence policy');
const constructor=name=>name.split('-').map(capitalize).join('');
const generated=`-- Generated from cache-persister.ts and namespaces/browse.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.CachePersistence where
import Data.Aeson (Value, FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import Data.Scientific (Scientific)
import Data.Text (Text)
data StoredDocument = StoredDocument { ${fields.map(([name,type])=>`stored${capitalize(name)} :: ${type}`).join(', ')} } deriving (Eq, Show)
instance FromJSON StoredDocument where
  parseJSON = withObject "StoredDocument" (\\fields -> StoredDocument ${fields.map(([name])=>`<${name===fields[0][0]?'$':'*'}> fields .: ${JSON.stringify(name)}`).join(' ')})
instance ToJSON StoredDocument where
  toJSON value = object [${fields.map(([name])=>`${JSON.stringify(name)} .= stored${capitalize(name)} value`).join(', ')}]
data PersistedQuery = ${names.map(constructor).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
persistedQueryName :: PersistedQuery -> Text
${names.map(name=>`persistedQueryName ${constructor(name)} = ${JSON.stringify(name)}`).join('\n')}
persistenceVersion :: Integer
persistenceVersion = ${version}
${singletons.map(([name,value])=>`${name} :: Text\n${name} = ${JSON.stringify(value)}`).join('\n')}
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/CachePersistence.hs'),generated,process.argv.includes('--check'));
