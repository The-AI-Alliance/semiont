#!/usr/bin/env node
// Derive session adapter schemas from the reference SDK's public declarations.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const path=resolve(ROOT,'packages/typescript/sdk/src/session/oauth.ts');
const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const fail=message=>{throw Error(message);};
const type=node=>{
 if(node.kind===ts.SyntaxKind.StringKeyword)return {type:'string'};
 if(node.kind===ts.SyntaxKind.NumberKeyword)return {type:'number'};
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&!node.typeArguments&&node.typeName.text==='HttpEndpoint')return {$ref:'HttpEndpoint.json'};
 return fail('unread session adapter type: '+node.getText(source));
};
const schemas=Object.fromEntries(['IssuedTokens','DeviceCode','BeginAuthorizationOptions'].map(name=>{
 const matches=source.statements.filter(node=>ts.isInterfaceDeclaration(node)&&node.name.text===name);
 if(matches.length!==1||matches[0].typeParameters||matches[0].heritageClauses)fail('no single plain interface '+name);
 const required=[];
 const properties=Object.fromEntries(matches[0].members.map(member=>{
  if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.modifiers?.length)fail('unread session adapter member');
  if(!member.questionToken)required.push(member.name.text);
  return [member.name.text,type(member.type)];
 }));
 if(Object.keys(properties).length!==matches[0].members.length)fail('duplicate session adapter property');
 return [name,{title:name,type:'object',properties,required}];
}));
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/codegen/session-adapters.json'),JSON.stringify(schemas,null,2)+'\n',process.argv.includes('--check'));
