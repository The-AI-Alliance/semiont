#!/usr/bin/env node
/** Hold Haskell's common transport and typed bus to the reference interfaces. */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

const read = (path) => readFileSync(path, 'utf8');
const inventory = JSON.parse(read('packages/haskell/sdk/public-api.json'));
const plain = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function body(code, marker) {
  const from = code.indexOf(marker);
  if (from < 0) throw new Error(`missing reference declaration: ${marker}`);
  let depth = 1;
  let quote;
  const start = from + marker.length;
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
    } else if ('\'"`'.includes(char)) quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return code.slice(start, i);
  }
  throw new Error(`unterminated reference declaration: ${marker}`);
}

function declaredMembers(source, marker) {
  const members = new Set();
  for (const line of body(plain(source), marker).split('\n')) {
    if (!/^ {2}\S/.test(line)) continue;
    if (/^ {2}(?:private\b|readonly #|#)/.test(line)) continue;
    const member = /^ {2}(?:(?:readonly|public|async)\s+)*(\w+)\$?\s*(?:[:<(])/.exec(line);
    if (member) {
      if (member[1] !== 'constructor') members.add(member[1]);
    } else if (!/^ {2}[)>}]/.test(line)) throw new Error(`unreadable reference member: ${line}`);
  }
  if (members.size === 0) throw new Error(`empty reference declaration: ${marker}`);
  return members;
}

function haskellMembers(module, receiver) {
  const values = inventory.modules[module]?.values;
  if (!values) throw new Error(`missing compiled Haskell module: ${module}`);
  return new Set(Object.entries(values).filter(([, signature]) => {
    const first = signature.split(/\s+->\s+/)[0];
    return first === receiver || first.endsWith(`.${receiver}`);
  }).map(([name]) => name));
}

function same(label, expected, actual) {
  const missing = [...expected].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !expected.has(name));
  if (missing.length || extra.length) throw new Error(`${label}: missing [${missing}], extra [${extra}]`);
}

const transportSource = read('packages/typescript/core/src/transport.ts');
const wireProtocol = read('protocol/conformance/sdk/README.md').split('### Operations\n')[1]?.split('One driver holds one client:')[0];
if (!wireProtocol) throw new Error('missing wire driver protocol operations');
const operations = new Set([...wireProtocol.matchAll(/^\| ([^|]+)\|/gm)]
  .flatMap((row) => row[1].trim() === '`op`' ? [] : [...row[1].matchAll(/`([^`]+)`/g)].map((name) => name[1])));
const driver = read('packages/haskell/sdk/conformance/Main.hs');
function dispatch(name) {
  const header = new RegExp(`^${name} ::`, 'm').exec(driver);
  if (!header) throw new Error(`missing Haskell driver dispatcher: ${name}`);
  const rest = driver.slice(driver.indexOf('\n', header.index) + 1);
  const end = rest.search(/^[a-z]\w* ::/m);
  if (end < 0) throw new Error(`unbounded Haskell driver dispatcher: ${name}`);
  return new Set([...rest.slice(0, end).matchAll(/^  "([^"]+)" ->/gm)].map((match) => match[1]));
}
const implemented = dispatch('perform');
if (driver.includes('operation == "abandon"')) implemented.add('abandon');
same('Haskell wire driver operations', operations, implemented);
const workerProtocol = read('protocol/conformance/worker/README.md').split('## The worker driver\n')[1]?.split('It writes,')[0];
if (!workerProtocol) throw new Error('missing worker driver protocol operations');
const workerOperations = new Set([...workerProtocol.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]).filter((name) => name !== 'op'));
same('Haskell worker driver operations', workerOperations,
  new Set([...dispatch('workerPerform'), ...[...implemented].filter((name) => workerOperations.has(name))]));

// Every registered driver must reach the CI job that runs it. A locally
// installed binary cannot establish that an artifact crosses a job boundary.
const workflow = read('.github/workflows/ci.yml');
const jobHeaders = [...workflow.matchAll(/^  ([a-z][a-z0-9-]+):\n/gm)];
const jobs = new Map(jobHeaders.map((header, index) => [header[1], workflow.slice(header.index, jobHeaders[index + 1]?.index ?? workflow.length)]));
const implementations = JSON.parse(read('protocol/conformance/semiont.implementations.json')).sdks.haskell;
const wireFile = posix.normalize(posix.join('protocol/conformance', implementations.wire[0]));
const driverDirectory = posix.dirname(wireFile);
const artifact = (job, action) => job.split(/^      - name:/m).flatMap((step) => {
  if (!step.includes(`uses: actions/${action}-artifact@`)) return [];
  const name = /^          name: (\S+)$/m.exec(step)?.[1];
  const path = /^          path: (\S+)$/m.exec(step)?.[1];
  return name && path ? [{ name, path }] : [];
});
const producers = [...jobs].flatMap(([name, job]) => artifact(job, 'upload').filter((item) => item.path === driverDirectory).map((item) => ({ job: name, ...item })));
if (producers.length !== 1) throw new Error(`Haskell driver needs one artifact producer, found ${producers.length}`);
const [producer] = producers;
for (const [role, name] of [['wire', 'sdk-conformance'], ['worker', 'worker-conformance']]) {
  if (!implementations[role]) throw new Error(`Haskell has no registered ${role} driver`);
  const job = jobs.get(name);
  if (!job) throw new Error(`no CI job consumes Haskell's ${role} driver: ${name}`);
  const needs = /^    needs: \[([^\]]+)\]$/m.exec(job)?.[1].split(',').map((part) => part.trim());
  if (!needs?.includes(producer.job)) throw new Error(`${name} does not await ${producer.job}`);
  const fetched = artifact(job, 'download').some((item) => item.name === producer.name && item.path === producer.path);
  if (!fetched) throw new Error(`${name} does not download ${producer.name} to ${producer.path}`);
  if (!job.includes(`chmod +x ${wireFile}*`)) throw new Error(`${name} does not restore the Haskell driver's executable modes`);
}
const runner = (name) => /^    runs-on: (\S+)$/m.exec(jobs.get(name))?.[1];
if (!runner('sdk-conformance') || runner('worker-conformance') !== runner('sdk-conformance')) throw new Error('Haskell wire and worker drivers need the same native runtime host');
same('Haskell transport', declaredMembers(transportSource, 'export interface ITransport {'), haskellMembers('Semiont.Transport', 'Transport'));
same('Haskell typed bus', declaredMembers(read('packages/typescript/core/src/bus.ts'), 'export class Bus {'), haskellMembers('Semiont.Bus', 'Bus'));
same('Haskell content transport', declaredMembers(transportSource, 'export interface IContentTransport {'), haskellMembers('Semiont.Content', 'ContentTransport'));
same('Haskell gateway operations', declaredMembers(transportSource, 'export interface IGatewayOperations {'), haskellMembers('Semiont.Gateway', 'GatewayOperations'));

const states = /export type ConnectionState\s*=([\s\S]*?);/.exec(transportSource);
if (!states) throw new Error('no reference connection-state vocabulary');
const expectedStates = new Set([...states[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));
const actualStates = new Set(Object.entries(inventory.modules['Semiont.Transport.Facts'].values)
  .filter(([name, signature]) => /^[A-Z]/.test(name) && !signature.includes('->') && signature.endsWith('.ConnectionState'))
  .map(([name]) => name[0].toLowerCase() + name.slice(1)));
same('Haskell connection states', expectedStates, actualStates);

// Accept future codes; the generated CommandError validates every other field.
const busType = /^(?:data|newtype) ([\w.]+)\b/.exec(inventory.modules['Semiont.Bus'].types.Bus.definition);
if (!busType) throw new Error('GHC declares no implementation of Bus');
const busPath = busType[1].split('.').slice(0, -1).join('/');
const busFiles = ['src', 'internal', 'generated'].map((directory) => `packages/haskell/sdk/${directory}/${busPath}.hs`).filter(existsSync);
if (busFiles.length !== 1) throw new Error(`Bus implementation source is ambiguous: ${busFiles}`);
const bus = read(busFiles[0]);
const readKeys = [...bus.matchAll(/KM\.lookup "(\w+)" fields/g)].map((match) => match[1]);
const commandError = JSON.parse(read('protocol/specs/src/components/schemas/CommandError.json'));
same('Haskell direct failure fields', new Set(['code']), new Set(readKeys));
if (commandError.properties.code?.type !== 'string') throw new Error('failure reader needs the new code type');
if (!bus.includes('fromJSON (Object (KM.delete "code" fields)) :: Result CommandError')) {
  throw new Error('failure fields besides the forward-compatible code must use the generated CommandError decoder');
}
console.log('PASS Haskell transport, typed bus and failure-reader censuses');
