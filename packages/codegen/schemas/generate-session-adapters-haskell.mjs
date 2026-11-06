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

// The source's secret proof is an object literal. Derive the complete form,
// refusing a new kind of expression instead of manufacturing its value.
const accountPath=resolve(ROOT,'packages/typescript/core/src/service-account.ts');
const account=ts.createSourceFile(accountPath,readFileSync(accountPath,'utf8'),ts.ScriptTarget.Latest,true);
const proofs=account.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='proof');
if(proofs.length!==1||!proofs[0].body)fail('no single service-account proof');
const branches=proofs[0].body.statements.filter(node=>ts.isIfStatement(node)
 &&ts.isBinaryExpression(node.expression)&&node.expression.operatorToken.kind===ts.SyntaxKind.InKeyword
 &&ts.isStringLiteral(node.expression.left)&&node.expression.left.text==='clientSecret'
 &&ts.isIdentifier(node.expression.right)&&node.expression.right.text==='credential');
if(branches.length!==1||!ts.isBlock(branches[0].thenStatement))fail('no single secret proof branch');
const returns=branches[0].thenStatement.statements.filter(ts.isReturnStatement);
const expression=returns.length===1?returns[0].expression:undefined;
if(!expression||!ts.isNewExpression(expression)||!ts.isIdentifier(expression.expression)
 ||expression.expression.text!=='URLSearchParams'||expression.arguments?.length!==1
 ||!ts.isObjectLiteralExpression(expression.arguments[0]))fail('secret proof is no single form literal');
const fields=expression.arguments[0].properties.map(property=>{
 if(!ts.isPropertyAssignment(property)||(!ts.isIdentifier(property.name)&&!ts.isStringLiteral(property.name)))fail('unread secret proof property');
 const value=property.initializer;
 const native=ts.isStringLiteral(value)?JSON.stringify(value.text):
  ts.isPropertyAccessExpression(value)&&ts.isIdentifier(value.expression)&&value.expression.text==='credential'
   ?({clientId:'identity',clientSecret:'secret'}[value.name.text]??fail('unread secret credential member'))
   :fail('unread secret proof expression');
 return [property.name.text,native];
});
if(new Set(fields.map(([name])=>name)).size!==fields.length)fail('duplicate secret proof property');
const assertionPolicy=JSON.parse(readFileSync(resolve(ROOT,'protocol/specs/src/session/client-assertion-cases.json'),'utf8'));
const grant=fields.find(([name])=>name==='grant_type');
if(!grant||grant[1]!==JSON.stringify(assertionPolicy.grantType))fail('secret grant differs from the client-credentials authority');
grant[1]='Policy.grantType';
const generated=`-- Generated from core/src/service-account.ts's secret proof; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.ServiceProof (secretProof) where
import Data.Text (Text)
import qualified Semiont.Internal.Generated.ClientAssertion as Policy
secretProof :: Text -> Text -> [(Text,Text)]
secretProof identity secret = [${fields.map(([name,value])=>`(${JSON.stringify(name)},${value})`).join(',')}]
`;
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/generated/Semiont/Internal/Generated/ServiceProof.hs'),generated,process.argv.includes('--check'));
