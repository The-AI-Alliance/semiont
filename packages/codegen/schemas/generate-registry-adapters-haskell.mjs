#!/usr/bin/env node
// Session notices and the session factory's inputs, read from the TypeScript SDK's declarations.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fail=message=>{throw Error(message);};
const load=name=>ts.createSourceFile(name,readFileSync(resolve(ROOT,'packages/typescript/sdk/src/session',name),'utf8'),ts.ScriptTarget.Latest,true);
const notices=load('session-signals.ts');
const names=['SessionEnded','PermissionDenied','KbIdentityConflict'];
const fieldsOf=name=>{
 const matches=notices.statements.filter(node=>ts.isInterfaceDeclaration(node)&&node.name.text===name);
 if(matches.length!==1||matches[0].heritageClauses||matches[0].typeParameters)fail('no plain notice '+name);
 return matches[0].members.map(member=>{
  if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.questionToken||member.modifiers?.length)fail('unread notice field');
  const node=member.type;
  let type;
  if(node.kind===ts.SyntaxKind.StringKeyword)type='Text';
  else if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&node.typeName.text==='SessionEndReason'&&!node.typeArguments)type='SessionEndReason';
  else if(ts.isUnionTypeNode(node)&&node.types.length===2&&node.types.some(value=>value.kind===ts.SyntaxKind.StringKeyword)&&node.types.some(value=>ts.isLiteralTypeNode(value)&&value.literal.kind===ts.SyntaxKind.NullKeyword))type='Maybe Text';
  else fail('unread notice field type '+node.getText(notices));
  return [member.name.text,type];
 });
};
const capitalize=name=>name[0].toUpperCase()+name.slice(1);
const fieldName=(name,field)=>name[0].toLowerCase()+name.slice(1)+capitalize(field);
const generated=`-- Generated from session/session-signals.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.SessionNotices where
import Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import Data.Text (Text)
import Semiont.Internal.Generated.Stored (SessionEndReason)
${names.map(name=>{
 const fields=fieldsOf(name);
 return `data ${name} = ${name} { ${fields.map(([field,type])=>`${fieldName(name,field)} :: ${type}`).join(', ')} } deriving (Eq, Show)
instance FromJSON ${name} where
  parseJSON = withObject ${JSON.stringify(name)} (\\fields -> ${name} ${fields.map(([field],index)=>`${index===0?'<$>':'<*>'} fields .: ${JSON.stringify(field)}`).join(' ')})
instance ToJSON ${name} where
  toJSON value = object [${fields.map(([field])=>`${JSON.stringify(field)} .= ${fieldName(name,field)} value`).join(', ')}]`;
}).join('\n')}
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/SessionNotices.hs'),generated,process.argv.includes('--check'));

const factory=load('session-factory.ts');
const optionTypes={KnowledgeBase:'KnowledgeBase',SessionStorage:'Storage.SessionStorage',SessionSignals:'Signals.SessionSignals'};
const optionFields=[];
const options=factory.statements.filter(node=>ts.isInterfaceDeclaration(node)&&node.name.text==='SessionFactoryOptions');
if(options.length!==1||options[0].heritageClauses||options[0].typeParameters)fail('no plain session-factory inputs');
for(const member of options[0].members){
 if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.questionToken||member.modifiers?.length)fail('unread session-factory input');
 const type=member.type;let native;
 if(ts.isTypeReferenceNode(type)&&ts.isIdentifier(type.typeName)&&!type.typeArguments)native=optionTypes[type.typeName.text]??fail('unread session-factory type '+type.getText(factory));
 else if(ts.isFunctionTypeNode(type)&&type.parameters.length===1&&type.parameters[0].type&&ts.isTypeReferenceNode(type.parameters[0].type)&&type.parameters[0].type.typeName.getText(factory)==='SemiontSessionError'&&type.type.kind===ts.SyntaxKind.VoidKeyword)native='SessionError -> IO ()';
 else fail('unread session-factory member type '+type.getText(factory));
 optionFields.push([member.name.text,native]);
}
const optionsGenerated=`-- Generated from session/session-factory.ts; do not edit.
module Semiont.Internal.Generated.SessionFactoryOptions where
import Semiont.Types (KnowledgeBase)
import Semiont.Errors (SessionError)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.State.SessionSignals as Signals
data SessionFactoryOptions = SessionFactoryOptions
  { ${optionFields.map(([name,type])=>`sessionFactoryOptions${capitalize(name)} :: ${type}`).join('\n  , ')}
  }
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/SessionFactoryOptions.hs'),optionsGenerated,process.argv.includes('--check'));
