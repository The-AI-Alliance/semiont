#!/usr/bin/env node
// Derive the SDK-owned annotation shapes from their public TypeScript owners.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {writeOrCheck} from '../lib/committed-source.mjs';
import {propertyRanges,scalars,unicodeVersion} from './unicode-properties.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sources=['annotation-builders.ts','fuzzy-anchor.ts','pdf-coordinates.ts'].map(file=>{
 const path=resolve(ROOT,'packages/typescript/core/src',file);
 return ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
});
const schemas={};
const fail=message=>{throw Error(message);};
const declaration=name=>{
 const found=sources.flatMap(source=>source.statements.filter(node=>(ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node))&&node.name.text===name));
 if(found.length!==1)fail('no single annotation declaration '+name);
 return found[0];
};
const type=node=>{
 if(node.kind===ts.SyntaxKind.StringKeyword)return {type:'string'};
 if(node.kind===ts.SyntaxKind.NumberKeyword)return {type:'number'};
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&!node.typeArguments&&['AnchorMethod','MatchQuality'].includes(node.typeName.text))return {$ref:node.typeName.text+'.json'};
 return fail('unread annotation adapter type: '+node.getText());
};
const derive=name=>{
 if(schemas[name])return schemas[name];
 const node=declaration(name);
 if(node.typeParameters)fail('generic annotation adapter '+name);
 if(ts.isTypeAliasDeclaration(node)){
  if(!ts.isUnionTypeNode(node.type))fail('annotation vocabulary is no union');
  const values=node.type.types.map(value=>ts.isLiteralTypeNode(value)&&ts.isStringLiteral(value.literal)?value.literal.text:fail('annotation vocabulary is no string literal'));
  if(new Set(values).size!==values.length)fail('duplicate annotation vocabulary');
  return schemas[name]={title:name,type:'string',enum:values};
 }
 const required=[],properties={};
 for(const clause of node.heritageClauses??[]){
  if(clause.token!==ts.SyntaxKind.ExtendsKeyword)fail('unread annotation heritage');
  for(const parent of clause.types){
   if(!ts.isIdentifier(parent.expression)||parent.typeArguments)fail('unread annotation parent');
   const base=derive(parent.expression.text);
   if(base.type!=='object')fail('annotation parent is no object');
   Object.assign(properties,base.properties); required.push(...base.required);
  }
 }
 for(const member of node.members){
  if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.modifiers?.length)fail('unread annotation property');
  const key=member.name.text;
  if(key in properties)fail('duplicate annotation property '+key);
  properties[key]=type(member.type);
  if(!member.questionToken)required.push(key);
 }
 return schemas[name]={title:name,type:'object',properties,required};
};
for(const name of ['QuotedText','TextSpan','ReconciledSpan','AnchorMethod','MatchQuality','PdfCoordinate'])derive(name);
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/codegen/annotation-adapters.json'),JSON.stringify(schemas,null,2)+'\n',process.argv.includes('--check'));

// Unicode default lowercasing has one context-sensitive non-locale rule: final
// sigma. Derive the character properties and mappings from the JS runtime's
// Unicode data, including multi-code-point mappings; Haskell Text.toLower
// deliberately implements only unconditional mappings.
const casedRanges=propertyRanges(/\p{Cased}/u),ignoredRanges=propertyRanges(/\p{Case_Ignorable}/u),whiteSpaceRanges=propertyRanges(/\p{White_Space}/u);
const mappings=[],finals=[];
for(const code of scalars()){
 const char=String.fromCodePoint(code),lower=char.toLowerCase();
 if(lower!==char)mappings.push([code,Array.from(lower,c=>c.codePointAt(0))]);
 const atEnd=('A'+char+' ').toLowerCase().slice(1,-1);
 if(atEnd!==lower)finals.push([code,Array.from(atEnd,c=>c.codePointAt(0))]);
}
const chars=values=>`[${values.map(value=>`chr ${value}`).join(',')}]`;
const generated=`-- Generated from Node's Unicode ${unicodeVersion} data; do not edit.
module Semiont.Internal.Generated.UnicodeCase (lowerChar, finalChar, isCased, caseIgnorable, whiteSpace) where
import Data.Char (chr, ord)
import qualified Data.IntMap.Strict as Map
lowerChar, finalChar :: Char -> String
lowerChar char = Map.findWithDefault [char] (ord char) lower
finalChar char = Map.findWithDefault (lowerChar char) (ord char) final
lower, final :: Map.IntMap String
lower = Map.fromDistinctAscList [${mappings.map(([code,values])=>`(${code},${chars(values)})`).join(',')}]
final = Map.fromDistinctAscList [${finals.map(([code,values])=>`(${code},${chars(values)})`).join(',')}]
isCased, caseIgnorable, whiteSpace :: Char -> Bool
isCased char = within (ord char) cased
caseIgnorable char = within (ord char) ignored
whiteSpace char = within (ord char) spaces
within :: Int -> [(Int,Int)] -> Bool
within code ranges = case dropWhile ((<code) . snd) ranges of
  (start,_):_ -> start<=code
  [] -> False
cased, ignored, spaces :: [(Int,Int)]
cased = [${casedRanges.map(([start,end])=>`(${start},${end})`).join(',')}]
ignored = [${ignoredRanges.map(([start,end])=>`(${start},${end})`).join(',')}]
spaces = [${whiteSpaceRanges.map(([start,end])=>`(${start},${end})`).join(',')}]
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/UnicodeCase.hs'),generated,process.argv.includes('--check'));
