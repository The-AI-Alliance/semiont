#!/usr/bin/env node
// Derive the native report sums from the reference SDK's tagged unions.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const path=resolve(ROOT,'packages/typescript/sdk/src/awaitable.ts');
const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const fail=message=>{throw Error(message);};
const upper=name=>name[0].toUpperCase()+name.slice(1);
const quoted=node=>ts.isLiteralTypeNode(node)&&ts.isStringLiteral(node.literal)?node.literal.text:fail('report index or tag is not a string');
const type=node=>{
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&node.typeName.text==='C'&&!node.typeArguments)return 'completion';
 if(node.kind===ts.SyntaxKind.NumberKeyword)return 'Integer';
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&node.typeName.text==='Pick'){
  const args=node.typeArguments;
  if(args?.length!==2||args[0].getText(source)!=='FrameRefusal'||!ts.isUnionTypeNode(args[1])||args[1].types.map(quoted).join(',')!=='channel,member,reason')fail('unread frame refusal report fields');
  return 'FrameRefusal';
 }
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&node.typeName.text==='ResourceId'&&!node.typeArguments)return 'ResourceId';
 const indexes=[];
 while(ts.isIndexedAccessTypeNode(node)){indexes.unshift(quoted(node.indexType));node=node.objectType;}
 if(!ts.isTypeReferenceNode(node)||!ts.isIdentifier(node.typeName)||node.typeName.text!=='components'||indexes.shift()!=='schemas'||!indexes.length)fail('unread report data type');
 return indexes.map(upper).join('');
};
const sum=(name,tag,prefix)=>{
 const declarations=source.statements.filter(node=>ts.isTypeAliasDeclaration(node)&&node.name.text===name);
 if(declarations.length!==1||!ts.isUnionTypeNode(declarations[0].type))fail(`no single report union ${name}`);
 const rows=declarations[0].type.types.map(node=>{
  if(!ts.isTypeLiteralNode(node))fail('report branch is not a record');
  const fields=node.members.map(member=>{
   if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.questionToken||member.modifiers?.length)fail('unread report member');
   return [member.name.text,member.type];
  });
  if(new Set(fields.map(([key])=>key)).size!==fields.length)fail('duplicate report member');
  const marker=fields.find(([key])=>key===tag);
  if(!marker)fail('report branch has no tag');
  const label=quoted(marker[1]);
  return {label,constructor:prefix+upper(label),fields:fields.filter(([key])=>key!==tag).map(([key,value])=>({key,type:type(value)}))};
 });
 if(new Set(rows.map(row=>row.constructor)).size!==rows.length)fail('duplicate report constructor');
 const generic=rows.some(row=>row.fields.some(field=>field.type==='completion'));
 const parameters=declarations[0].typeParameters;
 if(generic?(parameters?.length!==1||parameters[0].name.text!=='C'):parameters?.length)fail('report type parameters changed');
 const native=name==='UploadProgress'?'UploadEvent':name;
 return `data ${native}${generic?' completion':''} = ${rows.map(row=>row.constructor+' '+row.fields.map(field=>field.type).join(' ')).join(' | ')} deriving (Eq, Show)
instance ${generic?'ToJSON completion => ':''}ToJSON (${native}${generic?' completion':''}) where
${rows.map(row=>`  toJSON (${row.constructor} ${row.fields.map((_,index)=>`value${index}`).join(' ')}) = object [${[`${JSON.stringify(tag)} .= (${JSON.stringify(row.label)} :: Text)`,...row.fields.map((field,index)=>field.type==='FrameRefusal'?`${JSON.stringify(field.key)} .= object ["channel" .= refusedChannel value${index}, "member" .= member (fault value${index}), "reason" .= (case reason (fault value${index}) of Lacks -> ("lacks" :: Text); Malformed -> "malformed")]`:`${JSON.stringify(field.key)} .= value${index}`)].join(', ')}]`).join('\n')}
`;
};
const generated=`-- Generated from sdk/src/awaitable.ts report unions. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.OperationReports (JobEvent(..), UploadEvent(..)) where
import Data.Aeson (ToJSON(..), object, (.=))
import Data.Text (Text)
import Semiont.Types
import Semiont.Internal.Transport (FrameRefusal(..))
import Semiont.Internal.Required (Fault(..), FaultReason(..))
${sum('JobEvent','kind','')}
${sum('UploadProgress','phase','Upload')}`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/OperationReports.hs'),generated,process.argv.includes('--check'));
