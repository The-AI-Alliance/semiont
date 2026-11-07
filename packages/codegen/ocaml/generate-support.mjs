import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/LICENSE'),
  readFileSync(resolve(root, 'LICENSE'), 'utf8'), process.argv.includes('--check'));
const policy = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/sign-in-store/owner-only.json'), 'utf8'));
const mode = (name) => {
  const value = policy[name].value;
  if (!/^0[0-7]{3}$/.test(value)) throw new Error(`${name} is not an octal mode`);
  return `0o${value.slice(1)}`;
};
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/probes/store_policy.ml'),
  '(* Generated from sign-in-store/owner-only.json. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n' +
  `let directory_mode = ${mode('directoryMode')}\nlet file_mode = ${mode('fileMode')}\n`,
  process.argv.includes('--check'));

const offsets = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/text/offset-cases.json'), 'utf8'));
const cases = offsets.cases.map(({ text, codePoints, spans }) =>
  `  (${ocamlString(text)}, ${codePoints}, [${spans.map(({ exact, occurrence, start, end }) =>
    `(${ocamlString(exact)}, ${occurrence}, ${start}, ${end})`).join('; ')}])`);
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/probes/unicode_cases.ml'),
  '(* Generated from text/offset-cases.json. Do not edit. *)\n\n[@@@ocamlformat "disable"]\nlet cases = [\n' + cases.join(';\n') + '\n]\n',
  process.argv.includes('--check'));

const sessionSource = 'protocol/specs/src/session/cases.json';
const { refreshSchedule, tokenExpiry } = JSON.parse(readFileSync(resolve(root, sessionSource), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/probes/session_cases.ml'),
  `(* Generated from ${sessionSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let cases = ${ocamlString(JSON.stringify({ refreshSchedule, tokenExpiry }))}\n`,
  process.argv.includes('--check'));

const openapi = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/openapi.json'), 'utf8'));
const busPaths = new Map(Object.entries(openapi.paths).flatMap(([path, item]) => {
  const target = item.$ref === undefined ? item
    : JSON.parse(readFileSync(resolve(root, 'protocol/specs/src', item.$ref), 'utf8'));
  return target.post?.operationId === undefined ? [] : [[target.post.operationId, path]];
}));
const route = (operation) => {
  const path = busPaths.get(operation);
  if (path === undefined || path.includes('{')) throw new Error(`No static POST route for ${operation}`);
  return ocamlString(path);
};
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/conformance/paths.ml'),
  '(* Generated from the OpenAPI bus paths. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n\n' +
  `let subscribe = ${route('subscribeToBus')}\nlet emit = ${route('emitOnBus')}\n`,
  process.argv.includes('--check'));
