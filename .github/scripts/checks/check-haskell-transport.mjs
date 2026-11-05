#!/usr/bin/env node
/** Hold Haskell's common transport and typed bus to the reference interfaces. */
import { readFileSync } from 'node:fs';

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
same('Haskell transport', declaredMembers(transportSource, 'export interface ITransport {'), haskellMembers('Semiont.Transport', 'Transport'));
same('Haskell typed bus', declaredMembers(read('packages/typescript/core/src/bus.ts'), 'export class Bus {'), haskellMembers('Semiont.Bus', 'Bus'));
const states = /export type ConnectionState\s*=([\s\S]*?);/.exec(transportSource);
if (!states) throw new Error('no reference connection-state vocabulary');
const expectedStates = new Set([...states[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));
const actualStates = new Set(Object.entries(inventory.modules['Semiont.Transport.Facts'].values)
  .filter(([name, signature]) => /^[A-Z]/.test(name) && !signature.includes('->') && signature.endsWith('.ConnectionState'))
  .map(([name]) => name[0].toLowerCase() + name.slice(1)));
same('Haskell connection states', expectedStates, actualStates);

// Accept future codes; the generated CommandError validates every other field.
const bus = read('packages/haskell/sdk/src/Semiont/Bus.hs');
const readKeys = [...bus.matchAll(/KM\.lookup "(\w+)" fields/g)].map((match) => match[1]);
const commandError = JSON.parse(read('protocol/specs/src/components/schemas/CommandError.json'));
same('Haskell direct failure fields', new Set(['code']), new Set(readKeys));
if (commandError.properties.code?.type !== 'string') throw new Error('failure reader needs the new code type');
if (!bus.includes('fromJSON (Object (KM.delete "code" fields)) :: Result CommandError')) {
  throw new Error('failure fields besides the forward-compatible code must use the generated CommandError decoder');
}
console.log('PASS Haskell transport, typed bus and failure-reader censuses');
