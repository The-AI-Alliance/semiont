import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { ocamlString } from '../lib/ocaml-source.mjs';
import { readRequiredShapes } from '../schemas/required-shapes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { names, shapes } = readRequiredShapes(root, (message) => { throw new Error(message); });
const string = ocamlString;
const list = (write) => (values) => `[${values.map(write).join('; ')}]`;
const pairs = (write) => (values) => list(([key, value]) => `(${string(key)}, ${write(value)})`)(Object.entries(values));
const option = (write) => (value) => value === undefined ? 'None' : `Some (${write(value)})`;
const kind = (value) => value[0].toUpperCase() + value.slice(1);
const literal = (value) => {
  if (value === null) return '`Null';
  if (typeof value === 'boolean') return `\`Bool ${value}`;
  if (typeof value === 'string') return `\`Stringlit ${string(JSON.stringify(value))}`;
  return `\`${Number.isInteger(value) ? 'Intlit' : 'Floatlit'} ${string(String(value))}`;
};
const shape = (value) => {
  const fields = {
    ref: ['reference', option(string)],
    kinds: ['kinds', option(list(kind))],
    enum: ['enum', option(list(literal))],
    recognized: ['recognized', option(list(string))],
    pattern: ['pattern', option(list(({ of, min, max }) =>
      `(${list(([lo, hi]) => `(${lo}, ${hi})`)(of)}, ${min}, ${option(String)(max)})`))],
    minLength: ['min_length', option(String)],
    maxLength: ['max_length', option(String)],
    minimum: ['minimum', option((number) => string(String(number)))],
    maximum: ['maximum', option((number) => string(String(number)))],
    minItems: ['min_items', option(String)],
    maxItems: ['max_items', option(String)],
    required: ['required', list(string)],
    members: ['members', pairs(shape)],
    closed: ['closed', option(list(string))],
    items: ['items', option(shape)],
    values: ['values', option(shape)],
    oneOf: ['variants', list(shape)],
    discriminator: ['discriminator', option(({ property, mapping }) => `(${string(property)}, ${pairs(String)(mapping)})`)],
    allOf: ['all_of', list(shape)],
  };
  const updates = Object.entries(value).map(([key, entry]) => {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unsupported required shape keyword ${key}`);
    const [field, write] = fields[key];
    return `${field} = ${write(entry)}`;
  });
  return updates.length ? `{ any with ${updates.join('; ')} }` : 'any';
};
const header = '(* Generated from OpenAPI component schemas through required-shapes.mjs. Do not edit. *)\n\n[@@@ocamlformat "disable"]\n';
// Each shape is built by a function of its own: built in the module's initializer, the table is more than the
// native compiler can allocate registers for.
const definitions = names.map((name, index) => `let shape_${index} () = ${shape(shapes.get(name))}`);
const entries = names.map((name, index) => `  (${string(name)}, shape_${index});`);
writeOrCheck(root, resolve(root, 'packages/ocaml/sdk/lib/schema_shapes.ml'),
  `${header}\nopen Schema_shape\n\n${definitions.join('\n')}\n\nlet all = [\n${entries.join('\n')}\n]\n`,
  process.argv.includes('--check'));

const models = names.map((name) => {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsupported OCaml component name ${name}`);
  return name;
});
const modelApi = [
  "type 'schema t",
  "type 'schema descriptor",
  'type fault = { member : string; reason : [ `Lacks | `Malformed ] }',
  'type decode_error = Invalid_json of string | Invalid_payload of fault',
  "val decode : 'schema descriptor -> string -> ('schema t, decode_error) result",
  "val encode : 'schema t -> string",
  "val json : 'schema t -> Yojson.Raw.t",
];
const valueName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
if (new Set(models.map(valueName)).size !== models.length) throw new Error('OCaml component names collide');
const modelImpl = [
  "type 'schema t = Yojson.Raw.t",
  "type 'schema descriptor = string",
  'type fault = Schema_codec.fault = { member : string; reason : [ `Lacks | `Malformed ] }',
  'type decode_error = Schema_codec.error = Invalid_json of string | Invalid_payload of fault',
  'let decode name = Schema_codec.decode (Schema_shape.reference name)',
  'let encode value = Yojson.Raw.to_string value',
  'let json value = value',
];
for (const [extension, lines] of [
  ['mli', [...modelApi, ...models.map((name) => `val ${valueName(name)} : [ \`${name} ] descriptor`)]],
  ['ml', [...modelImpl, ...models.map((name) => `let ${valueName(name)} = ${string(name)}`)]],
]) {
  writeOrCheck(root, resolve(root, `packages/ocaml/sdk/lib/models.${extension}`),
    `${header}\n${lines.join('\n')}\n`, process.argv.includes('--check'));
}
