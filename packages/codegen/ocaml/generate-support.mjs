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

const specRoot = resolve(root, 'protocol/specs/src');
const readSpec = (file) => JSON.parse(readFileSync(resolve(specRoot, file), 'utf8'));
const openapi = readSpec('openapi.json');
const operations = new Map(Object.entries(openapi.paths).flatMap(([path, item]) => {
  const target = item.$ref === undefined ? item : readSpec(item.$ref);
  return Object.entries(target).flatMap(([method, operation]) => operation?.operationId === undefined
    ? [] : [[operation.operationId, { path, method, operation }]]);
}));
const names = {
  subscribe: 'subscribeToBus', emit: 'emitOnBus', health: 'getHealth',
  status: 'getStatus', current_user: 'getCurrentUser',
  protected_resource_metadata: 'getProtectedResourceMetadata',
  media_token: 'createMediaToken', representation: 'getResourceRepresentation',
  graph: 'getResourceJsonLd', annotations: 'getResourceAnnotations',
  anchored_text: 'getResourceAnchoredText', upload: 'uploadResource',
};
const routes = Object.entries(names).map(([name, id]) => {
  const { path, method } = operations.get(id);
  return `let ${name} = (${ocamlString(method.toUpperCase())}, ${ocamlString(path)})`;
});
const { transport, busRequest } = readSpec('errors/codes.json');
const statusCode = transport.codes.flatMap(({ code, status, statusFrom }) =>
  status !== undefined ? [`  | ${status} -> ${ocamlString(code)}`]
    : statusFrom !== undefined ? [`  | status when status >= ${statusFrom} -> ${ocamlString(code)}`] : []);
const busCode = busRequest.codes.flatMap(({ code, wire }) =>
  wire === undefined ? [] : [`  | Some ${ocamlString(wire)} -> ${ocamlString(code)}`]);
const retryStatuses = [...new Set(readSpec('retry/cases.json').rules
  .filter((row) => row.rule === 'transport' && row.retries && row.status !== undefined)
  .map((row) => row.status))].sort((a, b) => a - b);
const uploadFields = Object.keys(readSpec('components/schemas/ResourceUpload.json').properties);
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/http_facts.ml'),
  [
    '(* Generated from OpenAPI paths, error codes and retry cases. Do not edit. *)',
    '', '[@@@ocamlformat "disable"]', '', ...routes,
    'let status_code = function', ...statusCode, `  | _ -> ${ocamlString(transport.unclassified)}`,
    'let bus_failure = function', ...busCode, `  | _ -> ${ocamlString(busRequest.unrecognizedFailure)}`,
    `let retry_statuses = [${retryStatuses.join('; ')}]`,
    `let upload_fields = [${uploadFields.map(ocamlString).join('; ')}]`, '',
  ].join('\n'), process.argv.includes('--check'));
