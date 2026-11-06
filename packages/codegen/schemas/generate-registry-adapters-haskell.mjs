#!/usr/bin/env node
// Registry records and notice shapes are owned by the existing SDK declarations.
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {writeOrCheck} from '../lib/committed-source.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fail=message=>{throw Error(message);};
const load=name=>ts.createSourceFile(name,readFileSync(resolve(ROOT,'packages/typescript/sdk/src/session',name),'utf8'),ts.ScriptTarget.Latest,true);
const sources=['connect.ts','semiont-browser.ts','open-resource.ts'].map(load);
const schemas={};
const references=new Set(['KnowledgeBase','KbDescription','KbEndpoint','StoredSession']);
const propertyType=node=>{
 if(node.kind===ts.SyntaxKind.StringKeyword)return {type:'string'};
 if(node.kind===ts.SyntaxKind.NumberKeyword)return {type:'number'};
 if(node.kind===ts.SyntaxKind.BooleanKeyword)return {type:'boolean'};
 if(ts.isLiteralTypeNode(node)&&ts.isStringLiteral(node.literal))return {type:'string',enum:[node.literal.text]};
 if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&!node.typeArguments&&references.has(node.typeName.text))return {$ref:node.typeName.text+'.json'};
 if(ts.isTypeLiteralNode(node))return record(node.members);
 return fail('unread registry adapter type '+node.getText());
};
const record=members=>{
 const properties={},required=[];
 for(const member of members){
  if(!ts.isPropertySignature(member)||!ts.isIdentifier(member.name)||!member.type||member.modifiers?.length)fail('unread registry adapter property');
  const key=member.name.text;
  if(key in properties)fail('duplicate registry member '+key);
  properties[key]=propertyType(member.type);
  if(!member.questionToken)required.push(key);
 }
 return {type:'object',properties,required};
};
const declaration=name=>{
 const matches=sources.flatMap(source=>source.statements.filter(node=>(ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node))&&node.name.text===name));
 if(matches.length!==1)fail('no single registry declaration '+name);
 return matches[0];
};
for(const name of ['ConnectionIdentity','SignInOutcome','KbReadVerdict','TabCheck']){
 const node=declaration(name);
 if(node.typeParameters||node.heritageClauses)fail('unread registry heritage');
 let schema;
 if(ts.isInterfaceDeclaration(node))schema=record(node.members);
 else{
  if(!ts.isUnionTypeNode(node.type))fail('registry verdict is not a union');
  const branches=node.type.types.map(propertyType);
  schema={oneOf:branches};
  const discriminator=name==='TabCheck'?'TabVerdict':'KbReadKind';
  const kinds=branches.map(branch=>branch.properties.kind.enum[0]);
  if(kinds.some(kind=>typeof kind!=='string')||new Set(kinds).size!==kinds.length)fail('registry verdict has no unique kinds');
  schemas[discriminator]={type:'string',enum:kinds};
 }
 schemas[name]={title:name,...schema};
}
const outcome=schemas.SignInOutcome.properties.expected;
if(outcome?.type!=='object')fail('expected sign-in belief is not an inline object');
schemas.Expected={title:'Expected',...outcome};
schemas.SignInOutcome.properties.expected={$ref:'Expected.json'};
// The public source names raw ids as strings. Native adapters refine them by
// the shared identifier schemas, preserving all accepted strings on the wire.
if(schemas.ConnectionIdentity.properties.did.type!=='string')fail('registry identifiers changed type');
schemas.ConnectionIdentity.properties.did={$ref:'UserId.json'};
// TypeScript completes sign-in inline. The reusable SignedIn record is
// Python's dataclass, so read that declaration rather than restating it.
const python=`import ast, io, json, sys, tokenize
raw=open(sys.argv[1]).read()
tokens=list(tokenize.generate_tokens(io.StringIO(raw).readline))
starts=[index for index,token in enumerate(tokens[:-1]) if token.type==tokenize.NAME and token.string=='class' and token.start[1]==0 and tokens[index+1].string=='SignedIn']
assert len(starts)==1
start=starts[0]; depth=0; began=False; end=None
for token in tokens[start:]:
 if token.type==tokenize.INDENT: depth+=1; began=True
 elif token.type==tokenize.DEDENT:
  depth-=1
  if began and depth==0: end=token.start[0]-1; break
assert end is not None
source=ast.parse(''.join(raw.splitlines(keepends=True)[tokens[start].start[0]-1:end]))
classes=[node for node in source.body if isinstance(node,ast.ClassDef) and node.name=='SignedIn']
assert len(classes)==1 and not classes[0].bases
properties={};required=[]
for member in classes[0].body:
 if isinstance(member,ast.Expr) and isinstance(member.value,ast.Constant) and isinstance(member.value.value,str): continue
 assert isinstance(member,ast.AnnAssign) and isinstance(member.target,ast.Name)
 annotation=member.annotation
 nullable=isinstance(annotation,ast.BinOp) and isinstance(annotation.op,ast.BitOr) and isinstance(annotation.right,ast.Constant) and annotation.right.value is None
 if nullable: annotation=annotation.left
 assert isinstance(annotation,ast.Name)
 key=member.target.id.split('_'); key=key[0]+''.join(part.title() for part in key[1:])
 assert key not in properties
 if annotation.id=='str': schema={'type':'string'}
 else:
  assert annotation.id in ('KbEndpoint','KbDescription','StoredSession')
  schema={'$ref':annotation.id+'.json'}
 properties[key]=schema
 if member.value is None: required.append(key)
 else: assert nullable and isinstance(member.value,ast.Constant) and member.value.value is None
status_lines=[raw.splitlines()[token.start[0]-1] for index,token in enumerate(tokens) if token.type==tokenize.NAME and token.string=='KbSessionStatus' and index>0 and tokens[index-1].string=='type' and tokens[index-1].start[1]==0]
assert len(status_lines)==1
status=ast.parse(status_lines[0].split('=',1)[1].strip(),mode='eval').body
assert isinstance(status,ast.Subscript) and isinstance(status.value,ast.Name) and status.value.id=='Literal' and isinstance(status.slice,ast.Tuple)
statuses=[]
for value in status.slice.elts:
 assert isinstance(value,ast.Constant) and isinstance(value.value,str)
 statuses.append(value.value)
assert len(statuses)==len(set(statuses))
print(json.dumps({'signedIn':{'title':'SignedIn','type':'object','properties':properties,'required':required},'statuses':statuses}))
`;
const pythonOwned=JSON.parse(execFileSync('python3',['-c',python,resolve(ROOT,'packages/python/sdk/src/semiont/registry.py')],{encoding:'utf8'}));
schemas.SignedIn=pythonOwned.signedIn;
schemas.KbSessionStatus={title:'KbSessionStatus',type:'string',enum:pythonOwned.statuses};
writeOrCheck(ROOT,resolve(ROOT,'packages/haskell/sdk/codegen/registry-adapters.json'),JSON.stringify(schemas,null,2)+'\n',process.argv.includes('--check'));

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
