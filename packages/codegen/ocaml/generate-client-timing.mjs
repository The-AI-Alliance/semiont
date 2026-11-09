import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { readClientTiming } from '../schemas/client-timing-table.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = 'protocol/specs/src/client/timing.json';
const timing = readClientTiming(resolve(root, source), (message) => {
  throw new Error(`${source}: ${message}`);
});
const nameOf = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const definitions = timing.map(({ name, value }) =>
  typeof value === 'number'
    ? `let ${nameOf(name)} = ${value}`
    : `let ${nameOf(name)} = { attempts = ${value.attempts}; initial_delay_ms = ${value.initialDelayMs}; max_delay_ms = ${value.maxDelayMs} }`);
const header = `(* Generated from ${source}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n`;
const retry = 'type retry = { attempts : int; initial_delay_ms : int; max_delay_ms : int }';
const check = process.argv.includes('--check');
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/client_timing.ml'),
  [header, retry, ...definitions, ''].join('\n'), check);
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/client_timing.mli'),
  [header, retry, ...timing.map(({ name, value }) =>
    `val ${nameOf(name)} : ${typeof value === 'number' ? 'int' : 'retry'}`), ''].join('\n'), check);
