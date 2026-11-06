#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeOrCheck} from '../lib/committed-source.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
// Isolate declarations with the tokenizer: the host generator may run with
// Python 3.11 while the SDK it reads uses Python 3.12's type-alias syntax.
const python=String.raw`
import ast,json,sys,tokenize,io
from pathlib import Path
transport=Path(sys.argv[1]).read_text(); live=Path(sys.argv[2]).read_text()
def expr(raw,name):
 lines=[line for line in raw.splitlines() if line.startswith('type '+name+' = ')]
 assert len(lines)==1
 return ast.parse(lines[0].split('=',1)[1].strip(),mode='eval').body
def names(node):
 if isinstance(node,ast.BinOp) and isinstance(node.op,ast.BitOr): return names(node.left)+names(node.right)
 assert isinstance(node,ast.Name)
 return [node.id]
def record(raw,name):
 tokens=list(tokenize.generate_tokens(io.StringIO(raw).readline)); indices=[i for i,t in enumerate(tokens) if t.type==tokenize.NAME and t.string=='class' and t.start[1]==0 and tokens[i+1].string==name]
 assert len(indices)==1
 start=indices[0]; depth=0; began=False; end=None
 for t in tokens[start:]:
  if t.type==tokenize.INDENT: depth+=1; began=True
  elif t.type==tokenize.DEDENT:
   depth-=1
   if began and depth==0: end=t.start[0]-1; break
 assert end is not None
 tree=ast.parse(''.join(raw.splitlines(keepends=True)[tokens[start].start[0]-1:end])); node=tree.body[0]
 fields=[]
 for member in node.body:
  if isinstance(member,ast.Expr) and isinstance(member.value,ast.Constant) and isinstance(member.value.value,str):continue
  assert isinstance(member,ast.AnnAssign) and isinstance(member.target,ast.Name)
  fields.append((member.target.id,member.annotation))
 return fields
actions=[]
for name in names(expr(transport,'FaultAction')):
 fields=record(transport,name); payload=[];kind=None
 for key,annotation in fields:
  if key=='kind':
   assert isinstance(annotation,ast.Subscript) and isinstance(annotation.value,ast.Name) and annotation.value.id=='Literal' and isinstance(annotation.slice,ast.Constant) and isinstance(annotation.slice.value,str)
   kind=annotation.slice.value
  else:
   assert isinstance(annotation,ast.Name) and annotation.id=='int'
   payload.append(key)
 assert kind is not None
 actions.append({'name':name,'kind':kind,'fields':payload})
delivery=expr(live,'DeliveryOp');assert isinstance(delivery,ast.Subscript) and isinstance(delivery.value,ast.Name) and delivery.value.id=='Literal' and isinstance(delivery.slice,ast.Tuple)
ops=[]
for value in delivery.slice.elts:
 assert isinstance(value,ast.Constant) and isinstance(value.value,str)
 ops.append(value.value)
lines=[line for line in live.splitlines() if line.startswith('_SLACK:')];assert len(lines)==1
slack=ast.parse(lines[0]).body[0].value;assert isinstance(slack,ast.Constant) and type(slack.value) is int and slack.value>0
def function(raw,name):
 tokens=list(tokenize.generate_tokens(io.StringIO(raw).readline)); indices=[i for i,t in enumerate(tokens) if t.type==tokenize.NAME and t.string=='def' and t.start[1]==0 and tokens[i+1].string==name]
 assert len(indices)==1
 start=indices[0];depth=0;began=False;end=None
 for t in tokens[start:]:
  if t.type==tokenize.INDENT:depth+=1;began=True
  elif t.type==tokenize.DEDENT:
   depth-=1
   if began and depth==0:end=t.start[0]-1;break
 assert end is not None
 return ast.parse(''.join(raw.splitlines(keepends=True)[tokens[start].start[0]-1:end])).body[0]
def bounds(function,method,low,high):
 calls=[node for node in ast.walk(function) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr==method]
 assert len(calls)==1
 values={item.arg:item.value for item in calls[0].keywords}
 assert set(values)=={low,high}
 assert all(isinstance(value,ast.Constant) and type(value.value) is int for value in values.values())
 minimum=values[low].value;maximum=values[high].value
 assert 0<=minimum<=maximum
 return minimum,maximum
action_function=function(live,'fault_actions')
action_names={row['name'] for row in actions}
assert {node.id for node in ast.walk(action_function) if isinstance(node,ast.Name) and node.id in action_names}==action_names
delay_min,delay_max=bounds(action_function,'integers','min_value','max_value')
schedule_min,schedule_max=bounds(function(live,'fault_schedules'),'lists','min_size','max_size')
assert schedule_min>0
print(json.dumps({'actions':actions,'ops':ops,'slack':slack.value,'delayMin':delay_min,'delayMax':delay_max,'scheduleMin':schedule_min,'scheduleMax':schedule_max,'scenario':[name for name,_ in record(live,'LivenessScenario')],'spec':[name for name,_ in record(live,'LivenessSpec')],'log':[name for name,_ in record(transport,'RequestLogEntry')]}))
`;
const facts=JSON.parse(execFileSync('python3',['-c',python,resolve(root,'packages/python/sdk/src/semiont/testing/transport.py'),resolve(root,'packages/python/sdk/src/semiont/testing/liveness.py')],{encoding:'utf8'}));
const fail=message=>{throw Error(message);};
const capitalize=name=>name[0].toUpperCase()+name.slice(1);
const camel=name=>name.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase());
const scenario={outputs:'[IO ()]',settlements:'[IO ()]'};
const spec={setup:'FaultyTransport -> (LivenessScenario -> IO ()) -> IO ()',timeout_ms:'Integer',retry_budget:'Integer',cases:'Int',schedules:'Gen [FaultAction]',make_response:'Respond'};
const log={channel:'Text',action:'FaultAction',correlation_id:'Maybe Text',retry_key:'Text',payload:'Object'};
const record=(name,fields,types,extra=[])=>`data ${name} = ${name}\n  { ${[...fields.map(field=>`${name[0].toLowerCase()+name.slice(1)}${capitalize(camel(field))} :: ${types[field]??fail('unread native '+name+' field '+field)}`),...extra].join('\n  , ')}\n  }`;
writeOrCheck(root,resolve(root,'packages/haskell/sdk/generated/Semiont/Internal/Generated/Testing.hs'),`-- Generated from Python testing/transport.py and testing/liveness.py; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.Testing where
import Data.Aeson (Object, Value)
import Data.Text (Text)
import Semiont.Retry (RetryOptions)
import Semiont.Transport (Transport)
import Test.QuickCheck (Gen, oneof, chooseInteger, chooseInt, vectorOf)
data FaultAction = ${facts.actions.map(row=>row.name+row.fields.map(_=>' Integer').join('')).join(' | ')} deriving (Eq, Show)
faultKind :: FaultAction -> Text
${facts.actions.map(row=>`faultKind (${row.name}${row.fields.map(_=>' _').join('')}) = ${JSON.stringify(row.kind)}`).join('\n')}
data DeliveryOp = ${facts.ops.map(capitalize).join(' | ')} deriving (Eq, Ord, Show, Enum, Bounded)
deliveryOpName :: DeliveryOp -> Text
${facts.ops.map(word=>`deliveryOpName ${capitalize(word)} = ${JSON.stringify(word)}`).join('\n')}
faultActions :: Gen FaultAction
faultActions = oneof [${facts.actions.map(row=>row.fields.length===0?`pure ${row.name}`:row.fields.length===1&&row.fields[0]==='ms'?`${row.name} <$> chooseInteger (${facts.delayMin},${facts.delayMax})`:fail('unread fault generation fields')).join(', ')}]
faultSchedules :: Gen [FaultAction]
faultSchedules = chooseInt (${facts.scheduleMin},${facts.scheduleMax}) >>= \\count -> vectorOf count faultActions
slack :: Integer
slack = ${facts.slack}
type Respond = Text -> Object -> IO (Maybe Value)
${record('RequestLogEntry',facts.log,log)}
-- The transport owner fills this with its real carrier and its native controls.
data FaultyTransport = FaultyTransport
  { carrier :: Transport
  , queueReply :: Text -> [Maybe Value] -> IO ()
  , refuseWhen :: (Text -> Object -> IO (Maybe Object)) -> IO ()
  , requestLog :: IO [RequestLogEntry]
  , deliver :: Text -> Maybe Text -> Object -> IO ()
  }
${record('LivenessScenario',facts.scenario,scenario)}
${record('LivenessSpec',facts.spec,spec,['livenessClock :: RetryOptions'])}
`,process.argv.includes('--check'));
