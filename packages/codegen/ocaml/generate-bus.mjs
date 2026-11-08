import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryClasses } from '../bus/delivery.mjs';
import { replyNames } from '../bus/reply-names.mjs';
import { storedEventComponent } from '../bus/stored-event.mjs';
import { validateRegistry, validateRegistryFormat } from '../bus/validate-registry.mjs';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';
import { readRequiredShapes } from '../schemas/required-shapes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = 'protocol/specs/src/bus/registry.json';
const text = readFileSync(resolve(root, source), 'utf8');
validateRegistryFormat(text);
const registry = JSON.parse(text);
validateRegistry(registry);
const refuse = (message) => { throw new Error(message); };
const { shapes } = readRequiredShapes(root, refuse);
const schemaOf = (name) => JSON.parse(readFileSync(resolve(root, `protocol/specs/src/components/schemas/${name}.json`), 'utf8'));
const replies = replyNames(registry, schemaOf);
const events = schemaOf('BusEventMessage').properties.event.enum;
if (events.length !== 1 || typeof events[0] !== 'string') refuse('BusEventMessage needs one event name');
const delivery = deliveryClasses(registry);
const audiences = new Map(['everyone', 'scoped', 'declared'].flatMap((audience) =>
  registry.audience[audience].map((channel) => [channel, audience])));
const local = new Set(registry.inProcess.channels);
const effects = new Map(['reads', 'writes'].flatMap((effect) =>
  registry.effect[effect].map((channel) => [channel, effect])));
const nameOf = (name) => name.replace(/[:-]/g, '_');
const payload = ({ shape, schema, ...channel }) => {
  switch (shape) {
    case 'schema': return [schema, 'component'];
    case 'envelope': return [schema, 'envelope'];
    case 'storedEvent': return [storedEventComponent(channel), 'recorded'];
    case 'void': return ['Void', 'void'];
    case 'empty': return ['Empty', 'empty'];
    default: return refuse(`Unknown payload shape ${shape}`);
  }
};
const rows = registry.channels.map((channel) => {
  const [schema, kind] = payload(channel);
  if (!['empty', 'void'].includes(kind) && !shapes.has(schema)) refuse(`Unknown bus component ${schema}`);
  if (kind === 'recorded' && !shapes.has(channel.payload)) refuse(`Unknown event payload ${channel.payload}`);
  const index = (name) => `[ \`${name} ]`;
  const type = kind === 'recorded' ? `(${index(schema)} * ${index(channel.payload)}) recorded`
    : ['void', 'empty'].includes(kind) ? kind : `${index(schema)} ${kind}`;
  return { ...channel, schema, kind, type, name: nameOf(channel.channel) };
});
if (new Set(rows.map(({ name }) => name)).size !== rows.length) refuse('OCaml channel names collide');
const byChannel = new Map(rows.map((row) => [row.channel, row]));
const operations = registry.operations.map(({ request, result, failure }) => {
  const types = [request, result, failure].map((name) => byChannel.get(name).type);
  if (!byChannel.get(request).validate) refuse(`${request} cannot be emitted`);
  return { name: nameOf(request), request, result, failure, type: `(${types.join(', ')}) operation` };
});
const header = `(* Generated from ${source} and its OpenAPI components. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n`;
const types = [
  "type 'schema component", "type 'schema envelope", "type 'schemas recorded", "type empty", "type void",
  'type delivery = Positioned | Correlated | Passing',
  'type audience = Everyone | Scoped | Declared',
  'type operation_effect = Reads | Writes',
  'type payload = Component of string | Envelope of string | Recorded of { envelope : string; payload : string } | Empty | Void',
];
const api = [
  "type 'a decoded",
  'type fault = { member : string; reason : [ `Lacks | `Malformed ] }',
  'type decode_error = Invalid_json of string | Invalid_payload of fault',
  "val encode : 'a decoded -> string",
  "val json : 'a decoded -> Yojson.Raw.t",
  "type 'a channel", "type ('request, 'result, 'failure) operation",
  "type packed_channel = Channel : 'a channel -> packed_channel",
  "type packed_operation = Operation : ('request, 'result, 'failure) operation -> packed_operation",
  "val decode : 'a channel -> string -> ('a decoded, decode_error) result",
  "val decode_received : 'a channel -> string -> ('a decoded, decode_error) result",
  "val name : 'a channel -> string", "val payload : 'a channel -> payload",
  "val delivery : 'a channel -> delivery option", "val emittable : 'a channel -> bool",
  "val audience : 'a channel -> audience option", "val in_process : 'a channel -> bool",
  "val operation_effect : ('request, 'result, 'failure) operation -> operation_effect option",
  "val request : ('request, 'result, 'failure) operation -> 'request channel",
  "val result : ('request, 'result, 'failure) operation -> 'result channel",
  "val failure : ('request, 'result, 'failure) operation -> 'failure channel",
  "val reply_names : ('request, 'result, 'failure) operation -> string list",
  'val trace_field : string', 'val stream_event : string', 'val channels : packed_channel list', 'val operations : packed_operation list',
];
const impl = [
  "type 'a channel = { name : string; payload : payload; delivery : delivery option; emittable : bool; audience : audience option; in_process : bool }",
  "type ('request, 'result, 'failure) operation = { request : 'request channel; result : 'result channel; failure : 'failure channel; reply_names : string list; operation_effect : operation_effect option }",
  "type 'a decoded = Yojson.Raw.t",
  'type fault = Schema_codec.fault = { member : string; reason : [ `Lacks | `Malformed ] }',
  'type decode_error = Schema_codec.error = Invalid_json of string | Invalid_payload of fault',
  ...api.filter((line) => line.startsWith('type packed_')),
  'let json value = value',
  'let encode value = Yojson.Raw.to_string value',
  'let channel_shape channel =',
  '  let open Schema_shape in',
  '  match channel.payload with',
  '    | Component name -> reference name',
  '    | Recorded { envelope; payload } ->',
  '        { any with all_of = [reference envelope; object_ ~members:["payload", reference payload] ()] }',
  '    | Envelope name -> object_ ~required:["response"] ~members:["response", reference name] ~closed:["response"] ()',
  '    | Empty | Void -> object_ ~closed:[] ()',
  'let decode channel = Schema_codec.decode (channel_shape channel)',
  'let decode_received channel =',
  '  let shape = match channel.payload with',
  '    | Recorded { envelope; _ } -> Schema_shape.reference envelope',
  '    | _ -> channel_shape channel',
  '  in',
  '  Schema_codec.decode_received shape',
  ...['name', 'payload', 'delivery', 'emittable', 'audience', 'in_process', 'operation_effect', 'request', 'result', 'failure', 'reply_names'].map((field) => `let ${field} value = value.${field}`),
  `let trace_field = ${ocamlString(registry.trace.field)}`,
  `let stream_event = ${ocamlString(events[0])}`,
];
const upper = (value) => value[0].toUpperCase() + value.slice(1);
const someConstructor = (value) => value === undefined ? 'None' : `Some ${upper(value)}`;
const channels = rows.map(({ channel, name, schema, kind, payload: event, validate }) => {
  const shape = kind === 'recorded' ? `Recorded { envelope = ${ocamlString(schema)}; payload = ${ocamlString(event)} }`
    : ['void', 'empty'].includes(kind) ? upper(kind) : `${upper(kind)} ${ocamlString(schema)}`;
  const guarantee = someConstructor(delivery.get(channel));
  return `  let ${name} = { name = ${ocamlString(channel)}; payload = ${shape}; delivery = ${guarantee}; emittable = ${Boolean(validate)}; audience = ${someConstructor(audiences.get(channel))}; in_process = ${local.has(channel)} }`;
});
const operationValues = operations.map(({ name, request, result, failure }) =>
  `  let ${name} = { request = Channels.${name}; result = Channels.${nameOf(result)}; failure = Channels.${nameOf(failure)}; reply_names = [${replies.get(request).map(ocamlString).join('; ')}]; operation_effect = ${someConstructor(effects.get(request))} }`);
const files = [
  ['bus_registry.ml', [...types, ...impl, 'module Channels = struct', ...channels, 'end',
    'module Operations = struct', ...operationValues, 'end',
    `let channels = [${rows.map(({ name }) => `Channel Channels.${name}`).join('; ')}]`,
    `let operations = [${operations.map(({ name }) => `Operation Operations.${name}`).join('; ')}]`]],
  ['bus_registry.mli', [...types, ...api, 'module Channels : sig',
    ...rows.map(({ name, type }) => `  val ${name} : ${type} channel`), 'end',
    'module Operations : sig', ...operations.map(({ name, type }) => `  val ${name} : ${type}`), 'end']],
];
for (const [file, lines] of files) {
  writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib', file), `${header}\n${lines.join('\n')}\n`, process.argv.includes('--check'));
}

const surfaceSource = 'protocol/specs/src/client/surface.json';
const surface = JSON.parse(readFileSync(resolve(root, surfaceSource), 'utf8'));
const snake = (name) => name.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
const wired = surface.namespaces.flatMap(({ namespace, methods }) => {
  const functions = methods.flatMap(({ method, shape, via }) => {
    const name = snake(method);
    if (via.request && shape === 'promise' && !['addEntityTypes', 'createFromToken', 'pollUntilComplete'].includes(method)) {
      const operation = operations.find(({ request }) => request === via.request);
      if (!operation) refuse(`No operation for ${namespace}.${method}`);
      return [`  let ${name} client payload = Client_core.ask client Bus_registry.Operations.${operation.name} payload`];
    }
    if (via.local && shape === 'signal') {
      const channel = byChannel.get(via.local);
      if (!channel) refuse(`No local channel for ${namespace}.${method}`);
      return [`  let ${name} client payload = Client_core.publish client Bus_registry.Channels.${channel.name} payload`];
    }
    if (via.emit) {
      const channel = byChannel.get(via.emit);
      if (!channel) refuse(`No emitted channel for ${namespace}.${method}`);
      const emit = shape === 'count' ? 'drive' : 'signal';
      return [`  let ${name} client ?scope payload = Client_core.${emit} client ?scope Bus_registry.Channels.${channel.name} payload`];
    }
    return [];
  });
  if (!functions.length) return [];
  const module = namespace[0].toUpperCase() + namespace.slice(1);
  return [`module ${module} = struct`, ...functions, 'end', ''];
});
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/namespace_methods.ml'),
  `(* Generated from ${surfaceSource} and ${source}. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n\n` +
  wired.join('\n'), process.argv.includes('--check'));
