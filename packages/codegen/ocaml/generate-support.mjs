import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';
import { readCacheRefresh } from "../schemas/cache-refresh-table.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/LICENSE'),
  readFileSync(resolve(root, 'LICENSE'), 'utf8'), process.argv.includes('--check'));
const policy = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/sign-in-store/owner-only.json'), 'utf8'));
const mode = (name) => {
  const value = policy[name].value;
  if (!/^0[0-7]{3}$/.test(value)) throw new Error(`${name} is not an octal mode`);
  return `0o${value.slice(1)}`;
};
for (const dir of ['lib', 'probes']) writeOrCheck(root, resolve(root, `packages/ocaml/sdk/${dir}/store_policy.ml`),
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

const telemetrySource = 'sdk-telemetry/telemetry.json';
const telemetry = readSpec(telemetrySource);
const telemetryName = (name) => name.replace(/:\{channel\}$/, '').replaceAll('.', '_');
const spanRows = telemetry.spans.map(({ name, kind }) => {
  const constructor = kind[0].toUpperCase() + kind.slice(1);
  return `let ${telemetryName(name)} = (${ocamlString(name.replace('{channel}', ''))}, Telemetry.${constructor})`;
});
const metricRows = telemetry.metrics.map(({ name }) => `let ${telemetryName(name)} = ${ocamlString(name)}`);
const attributeRows = [...new Set([...telemetry.spans, ...telemetry.metrics]
  .flatMap(({ attributes }) => attributes.map(({ key }) => key)))].sort()
  .map((key) => `let attr_${telemetryName(key)} = ${ocamlString(key)}`);
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/telemetry_facts.ml'),
  [`(* Generated from ${telemetrySource}. Do not edit. *)`, '', '[@@@ocamlformat "disable"]', '',
    ...spanRows, ...metricRows, ...attributeRows, ''].join('\n'),
  process.argv.includes('--check'));

const refreshSource = 'client/refresh.json';
const refreshTable = readCacheRefresh(root, resolve(specRoot, refreshSource), (message) => {
  throw new Error(`${refreshSource}: ${message}`);
});
const strings = (values) => `[${values.map(ocamlString).join('; ')}]`;
const way = (value) => value === undefined ? '[]' : strings(value.split('.'));
const refreshRows = refreshTable.refresh.map((row) => {
  const when = row.when === undefined ? 'None' : `Some ${ocamlString(row.when)}`;
  return `  (${ocamlString(row.on)}, ${when}, ${row.reach === 'held'}, ${way(row.names?.resource)}, ${way(row.names?.annotation)}, ${way(row.carries)}, ${strings(row.refetches ?? [])}, ${strings(row.writes ?? [])}, ${strings(row.removes ?? [])});`;
});
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/live_facts.ml'),
  [`(* Generated from ${refreshSource}. Do not edit. *)`, '', '[@@@ocamlformat "disable"]', '',
    'let queries = [', ...refreshTable.queries.flatMap(({ name, asks }) =>
      asks === undefined ? [] : [`  (${ocamlString(name)}, ${ocamlString(asks)});`]),
    ']', 'let refresh = [', ...refreshRows, ']', ''].join('\n'),
  process.argv.includes('--check'));

const filterSource = 'jobs/filter-cases.json';
const filterCases = readSpec(filterSource).cases;
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/probes/job_filter_cases.ml'),
  `(* Generated from ${filterSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n\n` +
  `let cases = ${ocamlString(JSON.stringify(filterCases))}\n`,
  process.argv.includes('--check'));

const oauth = JSON.parse(readFileSync(resolve(root, 'protocol/specs/src/session/oauth.json'), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/oauth_facts.ml'),
  '(* Generated from session/oauth.json. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n' +
  oauth.clients.map(({ name, id }) => `let ${name} = ${ocamlString(id)}\n`).join('') +
  `let scope = ${ocamlString(oauth.scope.value)}\n`,
  process.argv.includes('--check'));

const storeSource = 'sign-in-store/cases.json';
const storeCases = JSON.parse(readFileSync(resolve(specRoot, storeSource), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/test/sign_in_cases.ml'),
  `(* Generated from ${storeSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let cases = ${ocamlString(JSON.stringify(storeCases.cases))}\n` +
  `let renewals = ${ocamlString(JSON.stringify(storeCases.renewals))}\n`,
  process.argv.includes('--check'));

const assertionSource = 'session/client-assertion-cases.json';
const assertion = JSON.parse(readFileSync(resolve(specRoot, assertionSource), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/assertion_facts.ml'),
  `(* Generated from ${assertionSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let lifetime_seconds = ${assertion.lifetimeSeconds}\n` +
  `let assertion_type = ${ocamlString(assertion.assertionType)}\n` +
  `let grant_type = ${ocamlString(assertion.grantType)}\n`,
  process.argv.includes('--check'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/test/assertion_cases.ml'),
  `(* Generated from ${assertionSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let cases = ${ocamlString(JSON.stringify({ form: assertion.form, grantType: assertion.grantType, assertionType: assertion.assertionType, thumbprints: assertion.thumbprints, cases: assertion.cases }))}\n`,
  process.argv.includes('--check'));

const mediaSource = 'media-types/registry.json';
const media = JSON.parse(readFileSync(resolve(specRoot, mediaSource), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/clone_facts.ml'),
  `(* Generated from ${mediaSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let authorable = [${media.mediaTypes.filter(({ authorable }) => authorable).map(({ mediaType, extension }) =>
    `(${ocamlString(mediaType)}, ${ocamlString(extension)})`).join('; ')}]\n`,
  process.argv.includes('--check'));

const stored = JSON.parse(readFileSync(resolve(specRoot, 'session/stored.json'), 'utf8'));
const discovery = JSON.parse(readFileSync(resolve(specRoot, 'discovery/DiscoveryDocument.json'), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/registry_facts.ml'),
  '(* Generated from session/stored.json and discovery/DiscoveryDocument.json. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n' +
  stored.keys.map(({ member, key }) => `let ${member.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())} = ${ocamlString(key)}\n`).join('') +
  `let session_prefix = ${ocamlString(stored.sessionKeyPrefix.prefix)}\n` +
  `let discovery_versions = [${discovery.properties.version.enum.join('; ')}]\n`,
  process.argv.includes('--check'));

const registryCases = JSON.parse(readFileSync(resolve(specRoot, 'session/registry-cases.json'), 'utf8'));
const sharedTiming = JSON.parse(readFileSync(resolve(specRoot, 'client/timing.json'), 'utf8'));
const clockCases = JSON.parse(readFileSync(resolve(specRoot, 'client/clock-cases.json'), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/test/registry_cases.ml'),
  '(* Generated from session/registry-cases.json and client/clock-cases.json. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n' +
  `let cases = ${ocamlString(JSON.stringify({ cases: registryCases.cases, openResourceOrder: registryCases.openResourceOrder }))}\n` +
  `let timing = ${ocamlString(JSON.stringify(Object.fromEntries(sharedTiming.timing.map(({ name, value }) => [name, value]))))}\n` +
  `let clock_cases = ${ocamlString(JSON.stringify(clockCases.cases.filter(({ subject }) => ['discovery', 'deviceGrant'].includes(subject))))}\n`,
  process.argv.includes('--check'));

const statesSource = 'client/state-units.json';
const states = JSON.parse(readFileSync(resolve(specRoot, statesSource), 'utf8'));
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/test/state_cases.ml'),
  `(* Generated from ${statesSource}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n` +
  `let timing = ${ocamlString(JSON.stringify(Object.fromEntries(sharedTiming.timing.map(({ name, value }) => [name, value]))))}\n` +
  `let cases = ${ocamlString(JSON.stringify(states.cases.filter(({ unit }) =>
    ['beckon', 'hoverDwell', 'search', 'sessionSignals'].includes(unit))))}\n`,
  process.argv.includes('--check'));
